import AppKit
import ColorSync
import CoreMedia
import ImageIO
import ScreenCaptureKit
import Synchronization
import VideoToolbox
import UniformTypeIdentifiers

/// Synchronous cancellation also covers a Stop that arrives before a delayed
/// Start. No capture callback can resurrect a cancelled generation.
final class DisplayGate: Sendable {
    private struct State {
        var current: UInt64?
        var ended: UInt64 = 0
        var suspensions: Set<String> = []
    }
    private let state = Mutex(State())

    func begin(_ generation: UInt64) -> Bool {
        state.withLock {
            guard $0.suspensions.isEmpty, generation > $0.ended else { return false }
            if let current = $0.current, current > generation { return false }
            $0.current = generation
            return true
        }
    }
    func contains(_ generation: UInt64) -> Bool { state.withLock { $0.suspensions.isEmpty && $0.current == generation } }
    var available: Bool { state.withLock { $0.suspensions.isEmpty } }
    func end(_ generation: UInt64) {
        state.withLock {
            $0.ended = max($0.ended, generation)
            if let current = $0.current, current <= $0.ended { $0.current = nil }
        }
    }
    func suspend(_ suspended: Bool, reason: String) {
        state.withLock {
            if suspended { $0.suspensions.insert(reason) } else { $0.suspensions.remove(reason) }
            if suspended, let current = $0.current {
                $0.ended = max($0.ended, current)
                $0.current = nil
            }
        }
    }
}

final class DisplayService: Sendable {
    private let gate = DisplayGate()
    private let controller: DisplayController
    private let reference: HostReference

    init(reference: HostReference) {
        self.reference = reference
        controller = DisplayController(reference: reference, gate: gate)
    }

    func command(session: UInt64, command: DisplayCommand) {
        switch command {
        case let .start(generation, _, _, _, _, _):
            guard gate.begin(generation) else {
                reference.host?.displayFailed(session: session, generation: generation, message: "Unlock or wake the Mac, then start viewing again.")
                return
            }
        case let .stop(generation): gate.end(generation)
        default: break
        }
        Task { await controller.handle(session: session, command: command) }
    }

    func suspend(_ suspended: Bool, reason: String) {
        gate.suspend(suspended, reason: reason)
        reference.host?.setDisplayAwake(awake: gate.available)
    }

    func displaysChanged() { Task { await controller.refreshDisplay() } }
}

private actor DisplayController {
    let reference: HostReference
    let gate: DisplayGate
    private var active: DisplayCapture? { didSet { keepDisplayAwake(active != nil) } }
    /// Held while a display is being watched. An idle display would otherwise
    /// sleep and end the view for someone who is only reading.
    private var wake: NSObjectProtocol?
    private var settings: DisplaySettings?
    private var revision: UInt64 = 0
    private var querying = false
    private var refreshRequested = false

    init(reference: HostReference, gate: DisplayGate) {
        self.reference = reference
        self.gate = gate
    }

    func handle(session: UInt64, command: DisplayCommand) async {
        switch command {
        case let .list(requestId):
            guard CGPreflightScreenCaptureAccess() else {
                reference.host?.displaySources(session: session, requestId: requestId, displays: [], message: "Allow Screen Recording in CmdPalm Settings → General → Display on the Mac. macOS may ask you to reopen CmdPalm.")
                return
            }
            do {
                let content = try await shareableContent()
                let names = await Self.displayNames()
                let displays = content.displays.filter { CGDisplayMirrorsDisplay($0.displayID) == kCGNullDirectDisplay }.compactMap { display -> DisplayInfo? in
                    guard let id = Self.identifier(display.displayID) else { return nil }
                    let pixels = DisplayVideo.sourcePixels(display)
                    return DisplayInfo(id: id, name: names[display.displayID] ?? "Display", width: UInt32(pixels.width), height: UInt32(pixels.height), main: display.displayID == CGMainDisplayID())
                }.sorted { $0.main && !$1.main || $0.main == $1.main && $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                reference.host?.displaySources(session: session, requestId: requestId, displays: displays, message: displays.isEmpty ? "No display is available. Wake or connect a display, then refresh." : nil)
            } catch {
                reference.host?.displaySources(session: session, requestId: requestId, displays: [], message: (error as? DisplayError)?.message ?? "The Mac could not list its displays. Check Screen Recording permission, then refresh.")
            }
        case let .start(generation, displayId, maxDimension, fps, bitrate, original):
            guard gate.contains(generation) else { return }
            let config = DisplaySettings(session: session, generation: generation, id: displayId, dimension: Int(maxDimension), fps: Int(fps), bitrate: Int(bitrate), original: original)
            await start(config)
        case let .configure(generation, fps, bitrate):
            guard gate.contains(generation), active?.generation == generation else { return }
            settings?.fps = Int(fps)
            settings?.bitrate = Int(bitrate)
            await active?.configure(fps: Int(fps), bitrate: Int(bitrate))
        case let .keyFrame(generation):
            if gate.contains(generation), active?.generation == generation { active?.requestKeyframe() }
        case let .focus(generation):
            guard gate.contains(generation), active?.generation == generation, Permissions.isTrusted(), let display = active?.displayID else { return }
            let bounds = CGDisplayBounds(display)
            CGWarpMouseCursorPosition(CGPoint(x: bounds.midX, y: bounds.midY))
        case let .stop(generation):
            guard active?.generation == generation else { return }
            let previous = active
            active = nil
            settings = nil
            await previous?.stop()
        }
    }

    private func start(_ config: DisplaySettings) async {
        revision &+= 1
        let ticket = revision
        let previous = active
        active = nil
        await previous?.stop()
        guard ticket == revision, gate.contains(config.generation) else { return }
        do {
            guard CGPreflightScreenCaptureAccess() else { throw DisplayError.permission }
            let content = try await shareableContent()
            guard ticket == revision, gate.contains(config.generation) else { return }
            guard let display = content.displays.first(where: { Self.identifier($0.displayID) == config.id }) else { throw DisplayError.missing }
            let capture = DisplayCapture(display: display, settings: config, gate: gate, reference: reference)
            active = capture
            settings = config
            try await capture.start()
            if ticket != revision || !gate.contains(config.generation) { await capture.stop() }
        } catch {
            guard ticket == revision, gate.contains(config.generation) else { return }
            reference.host?.displayFailed(session: config.session, generation: config.generation, message: (error as? DisplayError)?.message ?? "Screen capture stopped. Check Screen Recording permission and the selected display, then try again.")
        }
    }

    private func keepDisplayAwake(_ awake: Bool) {
        if awake, wake == nil {
            wake = ProcessInfo.processInfo.beginActivity(options: .idleDisplaySleepDisabled, reason: "A device is viewing this Mac’s display")
        } else if !awake, let wake {
            ProcessInfo.processInfo.endActivity(wake)
            self.wake = nil
        }
    }

    func refreshDisplay() async {
        guard let config = settings, gate.contains(config.generation), let active else { return }
        // Monitor changes can arrive together or during another device's
        // source query. Coalesce them instead of ending a healthy viewer.
        guard !querying else { refreshRequested = true; return }
        do {
            let content = try await shareableContent()
            guard gate.contains(config.generation) else { return }
            guard let display = content.displays.first(where: { Self.identifier($0.displayID) == config.id }) else {
                reference.host?.displayFailed(session: config.session, generation: config.generation, message: "The selected display was disconnected. Refresh the display list and choose another.")
                return
            }
            let pixels = DisplayVideo.sourcePixels(display)
            if display.width != active.sourceWidth || display.height != active.sourceHeight || display.displayID != active.displayID || pixels.width != active.sourcePixelWidth || pixels.height != active.sourcePixelHeight {
                await start(config)
            }
        } catch {
            reference.host?.displayFailed(session: config.session, generation: config.generation, message: "The display configuration changed. Refresh the display list and try again.")
        }
    }

    static func identifier(_ display: CGDirectDisplayID) -> String? {
        guard let uuid = CGDisplayCreateUUIDFromDisplayID(display)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, uuid) as String
    }

    private func shareableContent() async throws -> SCShareableContent {
        // Actor reentrancy must not turn a slow OS query into an unbounded
        // collection of simultaneous queries from refresh/start requests.
        guard !querying else { throw DisplayError.busy }
        querying = true
        defer {
            querying = false
            if refreshRequested {
                refreshRequested = false
                Task { await refreshDisplay() }
            }
        }
        return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    }

    @MainActor private static func displayNames() -> [CGDirectDisplayID: String] {
        var names: [CGDirectDisplayID: String] = [:]
        for screen in NSScreen.screens {
            if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber { names[number.uint32Value] = screen.localizedName }
        }
        return names
    }
}

struct DisplaySettings: Sendable {
    let session: UInt64
    let generation: UInt64
    let id: String
    let dimension: Int
    var fps: Int
    var bitrate: Int
    var original = false
}

private enum DisplayError: Error {
    case permission, missing, encoder, busy
    var message: String {
        switch self {
        case .permission: "Allow Screen Recording in CmdPalm Settings → General → Display on the Mac, then reopen CmdPalm if macOS asks."
        case .missing: "The selected display is no longer available. Refresh the display list and choose another."
        case .encoder: "Hardware video encoding is unavailable. Stop other screen-sharing or recording sessions, then try again."
        case .busy: "The Mac is still preparing its display list. Try again in a moment."
        }
    }
}

/// Geometry and AVCC conversion are kept independent of capture so their
/// bounds can be verified without screen permission or a physical display.
enum DisplayVideo {
    static func sourcePixels(_ display: SCDisplay) -> (width: Int, height: Int) {
        let filter = SCContentFilter(display: display, excludingWindows: [])
        return pixelSize(width: filter.contentRect.width > 0 ? Double(filter.contentRect.width) : Double(display.width),
                         height: filter.contentRect.height > 0 ? Double(filter.contentRect.height) : Double(display.height),
                         scale: Double(filter.pointPixelScale))
    }

    static func pixelSize(width: Double, height: Double, scale: Double) -> (width: Int, height: Int) {
        // Use the selected display's capture scale, including Retina and
        // rotated displays. Desktop point dimensions can discard text detail.
        let factor = scale.isFinite && scale > 0 ? min(scale, 4) : 1
        func pixels(_ points: Double) -> Int {
            guard points.isFinite, points > 0 else { return 2 }
            return max(2, Int((min(points, 65536) * factor).rounded()))
        }
        return (pixels(width), pixels(height))
    }

    static func size(width: Int, height: Int, maximum: Int, original: Bool = false) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (2, 2) }
        let longest = Double(min(max(maximum, 352), original ? 3840 : 1920))
        let shortest = floor(longest * 9 / 16)
        let wide = width >= height
        let scale = min(1, min((wide ? longest : shortest) / Double(width), (wide ? shortest : longest) / Double(height)))
        return (max(2, Int(Double(width) * scale) / 2 * 2), max(2, Int(Double(height) * scale) / 2 * 2))
    }

    static func annexB(_ data: Data, headerLength: Int, parameters: [Data]) -> Data? {
        guard (1...4).contains(headerLength), !data.isEmpty else { return nil }
        var result = Data()
        let marker: [UInt8] = [0, 0, 0, 1]
        for parameter in parameters { result.append(contentsOf: marker); result.append(parameter) }
        var offset = 0
        while offset < data.count {
            guard data.count - offset >= headerLength else { return nil }
            var length = 0
            for byte in data[offset..<(offset + headerLength)] { length = length << 8 | Int(byte) }
            offset += headerLength
            guard length > 0, length <= data.count - offset else { return nil }
            result.append(contentsOf: marker)
            result.append(data[offset..<(offset + length)])
            offset += length
        }
        return result
    }

    static func png(_ image: CVPixelBuffer) -> Data? {
        var cgImage: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(image, options: nil, imageOut: &cgImage) == noErr, let cgImage else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, cgImage, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    static func configureEncoder(_ encoder: VTCompressionSession, fps: Int, bitrate: Int) throws {
        let properties: [CFString: Any] = [
            kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel,
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_AverageBitRate: bitrate,
            kVTCompressionPropertyKey_ExpectedFrameRate: fps,
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 2,
            kVTCompressionPropertyKey_ColorPrimaries: kCVImageBufferColorPrimaries_ITU_R_709_2,
            kVTCompressionPropertyKey_TransferFunction: kCVImageBufferTransferFunction_ITU_R_709_2,
            kVTCompressionPropertyKey_YCbCrMatrix: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        ]
        guard VTSessionSetProperties(encoder, propertyDictionary: properties as CFDictionary) == noErr else { throw DisplayError.encoder }
        setRateLimit(encoder, bitrate: bitrate)
        // Set before preparation so the first frame can be emitted without
        // waiting for another frame on a static desktop.
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 0 as CFNumber)
        guard VTCompressionSessionPrepareToEncodeFrames(encoder) == noErr else { throw DisplayError.encoder }
        var hardware: Unmanaged<CFTypeRef>?
        let status = VTSessionCopyProperty(encoder, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, allocator: nil, valueOut: &hardware)
        let accelerated = hardware?.takeRetainedValue() as? Bool
        guard status == noErr, accelerated == true else { throw DisplayError.encoder }
    }

    static func setRateLimit(_ encoder: VTCompressionSession, bitrate: Int) {
        // AverageBitRate permits large spikes. Bound a one-second window
        // with room for an IDR; encoders that lack this key keep the target.
        let limit: [NSNumber] = [NSNumber(value: max(1, bitrate * 5 / 32)), NSNumber(value: 1.0)]
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_DataRateLimits, value: limit as CFArray)
    }
}

final class DisplayCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let displayID: CGDirectDisplayID
    let sourceWidth: Int
    let sourceHeight: Int
    let sourcePixelWidth: Int
    let sourcePixelHeight: Int
    let generation: UInt64
    private let display: SCDisplay
    private let settings: DisplaySettings
    private let sendFrame: @Sendable (Data, UInt64, Bool) -> Bool
    private let onFailure: @Sendable (String) -> Void
    private let gate: DisplayGate
    private let queue = DispatchQueue(label: "app.cmdpalm.display.encode", qos: .userInitiated)
    private struct Flags {
        var encoding = false
        var keyframe = true
        var stopped = false
        var forcedKeyframeInFlight = false
        var fps: Int
        var bitrate: Int
    }
    private let flags: Mutex<Flags>
    @MainActor private var stream: SCStream?
    @MainActor private var configuredFPS: Int?
    /// Confined to the sample handler queue, including invalidation.
    private var encoder: VTCompressionSession?
    /// One scaled surface allows a fresh IDR after packet loss even when the
    /// desktop is static and ScreenCaptureKit is only reporting idle updates.
    private var latestImage: CVPixelBuffer?
    private var latestTime = CMTime.invalid
    private var pendingImage = false
    private var lastEncodedTime = CMTime.invalid
    private var keyframeWorkQueued = false

    convenience init(display: SCDisplay, settings: DisplaySettings, gate: DisplayGate, reference: HostReference) {
        self.init(display: display, settings: settings, gate: gate, sendFrame: { data, timestamp, keyframe in
            reference.host?.displayFrame(session: settings.session, generation: settings.generation, data: data, timestampUs: timestamp, keyframe: keyframe) == true
        }, onFailure: { message in
            reference.host?.displayFailed(session: settings.session, generation: settings.generation, message: message)
        })
    }

    init(display: SCDisplay, settings: DisplaySettings, gate: DisplayGate,
         sendFrame: @escaping @Sendable (Data, UInt64, Bool) -> Bool,
         onFailure: @escaping @Sendable (String) -> Void) {
        self.display = display
        displayID = display.displayID
        sourceWidth = display.width
        sourceHeight = display.height
        let pixels = DisplayVideo.sourcePixels(display)
        sourcePixelWidth = pixels.width
        sourcePixelHeight = pixels.height
        generation = settings.generation
        self.settings = settings
        self.gate = gate
        self.sendFrame = sendFrame
        self.onFailure = onFailure
        flags = Mutex(Flags(fps: settings.fps, bitrate: settings.bitrate))
    }

    private func configuration(fps: Int) -> SCStreamConfiguration {
        let size = outputSize
        let config = SCStreamConfiguration()
        config.width = size.width
        config.height = size.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        config.queueDepth = 3
        config.pixelFormat = settings.original ? kCVPixelFormatType_32BGRA : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.colorSpaceName = settings.original ? CGColorSpace.sRGB : CGColorSpace.itur_709
        config.showsCursor = true
        config.capturesAudio = false
        config.captureMicrophone = false
        config.scalesToFit = true
        config.preservesAspectRatio = true
        return config
    }

    private var outputSize: (width: Int, height: Int) {
        DisplayVideo.size(width: settings.original ? sourcePixelWidth : sourceWidth,
                          height: settings.original ? sourcePixelHeight : sourceHeight,
                          maximum: settings.dimension, original: settings.original)
    }

    @MainActor func start() async throws {
        if !settings.original { try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do { try self.createEncoder(); continuation.resume() }
                catch { continuation.resume(throwing: error) }
            }
        } }
        guard gate.contains(generation), !flags.withLock({ $0.stopped }) else { await stop(); return }
        let fps = flags.withLock { $0.fps }
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration(fps: fps), delegate: self)
        self.stream = stream
        configuredFPS = fps
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        // A display reconfiguration can replace this capture without
        // changing the viewer's generation while startCapture is awaiting.
        if !gate.contains(generation) || flags.withLock({ $0.stopped }) || self.stream !== stream {
            try? await stream.stopCapture()
            await stop()
        }
    }

    @MainActor func stop() async {
        flags.withLock { $0.stopped = true }
        if let stream { try? await stream.stopCapture() }
        self.stream = nil
        configuredFPS = nil
        await withCheckedContinuation { continuation in
            queue.async {
                if let encoder = self.encoder {
                    VTCompressionSessionInvalidate(encoder)
                    self.encoder = nil
                }
                self.latestImage = nil
                self.latestTime = .invalid
                self.pendingImage = false
                self.keyframeWorkQueued = false
                continuation.resume()
            }
        }
    }

    @MainActor func configure(fps: Int, bitrate: Int) async {
        guard !settings.original, gate.contains(generation) else { return }
        flags.withLock { $0.fps = fps; $0.bitrate = bitrate }
        // Bitrate feedback is frequent. Reconfigure capture surfaces only
        // when its frame interval changes, rather than for every estimate.
        if let stream, configuredFPS != fps {
            do {
                try await stream.updateConfiguration(configuration(fps: fps))
                if self.stream === stream { configuredFPS = fps }
            } catch {
                if gate.contains(generation) { fail("The display could not adjust its frame rate. Start viewing again.") }
                return
            }
        }
        queue.async {
            guard let encoder = self.encoder, self.gate.contains(self.generation) else { return }
            let latest = self.flags.withLock { ($0.fps, $0.bitrate) }
            VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AverageBitRate, value: latest.1 as CFNumber)
            VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: latest.0 as CFNumber)
            DisplayVideo.setRateLimit(encoder, bitrate: latest.1)
        }
    }

    func requestKeyframe() {
        guard !settings.original else { return }
        flags.withLock { $0.keyframe = true }
        queue.async {
            guard !self.keyframeWorkQueued else { return }
            self.keyframeWorkQueued = true
            // A changing desktop normally supplies the next frame itself.
            // Reuse the cached surface only if it remains idle for a moment.
            self.queue.asyncAfter(deadline: .now() + .milliseconds(50)) { self.encodeLatestKeyframe() }
        }
    }

    private func encodeLatestKeyframe() {
        guard gate.contains(generation), !flags.withLock({ $0.stopped }), let latestImage else { keyframeWorkQueued = false; return }
        if flags.withLock({ $0.encoding }) {
            queue.asyncAfter(deadline: .now() + .milliseconds(16)) { self.encodeLatestKeyframe() }
            return
        }
        keyframeWorkQueued = false
        guard flags.withLock({ $0.keyframe }) else { return }
        pendingImage = false
        encode(latestImage, at: CMClockGetTime(CMClockGetHostTimeClock()))
    }

    private func createEncoder() throws {
        guard gate.contains(generation) else { return }
        let size = outputSize
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(size.width), height: Int32(size.height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { context, _, status, infoFlags, sample in
                guard let context else { return }
                Unmanaged<DisplayCapture>.fromOpaque(context).takeUnretainedValue().encoded(status: status, infoFlags: infoFlags, sample: sample)
            }, refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &encoder)
        guard status == noErr, let encoder else { throw DisplayError.encoder }
        let latest = flags.withLock { ($0.fps, $0.bitrate) }
        try DisplayVideo.configureEncoder(encoder, fps: latest.0, bitrate: latest.1)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, gate.contains(generation), !flags.withLock({ $0.stopped }), (settings.original || encoder != nil),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let value = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: value) else { return }
        switch status {
        case .complete: break
        case .blank, .suspended, .stopped:
            fail("The selected display is no longer available. Wake or unlock the Mac, then start viewing again.")
            return
        default: return
        }
        guard sampleBuffer.isValid, let image = sampleBuffer.imageBuffer else { return }
        if settings.original {
            guard !flags.withLock({ $0.stopped }) else { return }
            guard let png = autoreleasepool(invoking: { DisplayVideo.png(image) }) else {
                fail("The HD picture could not be prepared. Try Sharper text or start viewing again.")
                return
            }
            guard gate.contains(generation) else { return }
            guard png.count <= 16 * 1024 * 1024 else { fail("This HD picture is too large. Choose Sharper text for this screen content."); return }
            let seconds = CMTimeGetSeconds(sampleBuffer.presentationTimeStamp)
            guard seconds.isFinite, seconds >= 0 else { return }
            _ = sendFrame(png, UInt64(seconds * 1_000_000), true)
            return
        }
        latestImage = image
        latestTime = sampleBuffer.presentationTimeStamp
        pendingImage = true
        encodePendingImage()
    }

    private func encodePendingImage() {
        guard pendingImage, let latestImage, !flags.withLock({ $0.encoding || $0.stopped }), gate.contains(generation) else { return }
        pendingImage = false
        encode(latestImage, at: latestTime)
    }

    private func encode(_ image: CVPixelBuffer, at time: CMTime) {
        guard gate.contains(generation), let encoder else { return }
        let force: Bool? = flags.withLock {
            guard !$0.stopped, !$0.encoding else { return nil }
            $0.encoding = true
            let keyframe = $0.keyframe
            $0.keyframe = false
            $0.forcedKeyframeInFlight = keyframe
            return keyframe
        }
        guard let force else { return }
        let timestamp = lastEncodedTime.isValid && CMTimeCompare(time, lastEncodedTime) <= 0
            ? CMTimeAdd(lastEncodedTime, CMTime(value: 1, timescale: 1_000_000)) : time
        lastEncodedTime = timestamp
        let options = force ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        let result = VTCompressionSessionEncodeFrame(encoder, imageBuffer: image, presentationTimeStamp: timestamp,
            duration: .invalid, frameProperties: options, sourceFrameRefcon: nil, infoFlagsOut: nil)
        if result != noErr {
            flags.withLock { $0.encoding = false }
            fail("Hardware video encoding stopped. Try starting the view again.")
        }
    }

    private func encoded(status: OSStatus, infoFlags: VTEncodeInfoFlags, sample: CMSampleBuffer?) {
        defer {
            flags.withLock { $0.encoding = false }
            // Drain the newest pending frame even when screen motion ends
            // while an earlier frame is still being encoded.
            queue.async { self.encodePendingImage() }
        }
        guard gate.contains(generation), !flags.withLock({ $0.stopped }) else { return }
        guard status == noErr else { fail("Hardware video encoding stopped. Try starting the view again."); return }
        if infoFlags.contains(.frameDropped) {
            // The encoder maintains its own reference chain for intentional
            // rate-control drops. Only retry a specifically requested IDR.
            if flags.withLock({ $0.forcedKeyframeInFlight }) { requestKeyframe() }
            return
        }
        guard let sample, CMSampleBufferDataIsReady(sample), let block = sample.dataBuffer, let format = sample.formatDescription else {
            requestKeyframe()
            return
        }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
        var headerLength: Int32 = 0
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: &headerLength) == noErr else { requestKeyframe(); return }
        var parameters: [Data] = []
        if keyframe {
            for index in 0..<min(count, 8) {
                var bytes: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &bytes, parameterSetSizeOut: &size,
                    parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let bytes {
                    parameters.append(Data(bytes: bytes, count: size))
                }
            }
        }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0, length <= 1024 * 1024 else { fail("This frame could not be streamed at the selected quality. Choose Save battery and try again."); return }
        var data = Data(count: length)
        let copied = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
        let seconds = CMTimeGetSeconds(sample.presentationTimeStamp)
        guard copied == noErr, seconds.isFinite, seconds >= 0,
              let annexB = DisplayVideo.annexB(data, headerLength: Int(headerLength), parameters: parameters) else { requestKeyframe(); return }
        guard annexB.count <= 1024 * 1024 else { fail("This frame could not be streamed at the selected quality. Choose Save battery and try again."); return }
        if !sendFrame(annexB, UInt64(seconds * 1_000_000), keyframe) { requestKeyframe() }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        if !flags.withLock({ $0.stopped }) { fail("Screen capture stopped. Wake the selected display and check Screen Recording permission, then try again.") }
    }

    private func fail(_ message: String) {
        let firstFailure = flags.withLock {
            guard !$0.stopped else { return false }
            $0.stopped = true
            return true
        }
        guard firstFailure else { return }
        gate.end(generation)
        onFailure(message)
    }
}
