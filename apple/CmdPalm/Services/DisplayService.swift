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
        case let .start(generation, _, _, _, _, _, _):
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
        case let .start(generation, displayId, maxDimension, fps, bitrate, original, profile):
            guard gate.contains(generation) else { return }
            let config = DisplaySettings(session: session, generation: generation, id: displayId, dimension: Int(maxDimension), fps: Int(fps), bitrate: Int(bitrate), original: original, profile: profile)
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
        settings = nil
        await previous?.stop()
        guard ticket == revision, gate.contains(config.generation) else { return }
        var created: DisplayCapture?
        do {
            guard CGPreflightScreenCaptureAccess() else { throw DisplayError.permission }
            let content = try await shareableContent()
            guard ticket == revision, gate.contains(config.generation) else { return }
            guard let display = content.displays.first(where: { Self.identifier($0.displayID) == config.id }) else { throw DisplayError.missing }
            let capture = DisplayCapture(display: display, settings: config, gate: gate, reference: reference)
            created = capture
            active = capture
            settings = config
            try await capture.start()
            if ticket != revision || !gate.contains(config.generation) {
                if active === capture {
                    active = nil
                    settings = nil
                }
                await capture.stop()
            }
        } catch {
            if let created {
                if active === created {
                    active = nil
                    settings = nil
                }
                await created.stop()
            }
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
    var profile: DisplayProfile = .constrainedBaseline
}

/// Token bucket pacing captures at the active frame rate while keeping a
/// two-frame burst reserve so waking from an idle desktop is never delayed.
struct CaptureBucket: Sendable {
    static let burst = 2.0
    private(set) var interval: Double
    private(set) var credit: Double
    private var updated: Double

    init(fps: Int, now: Double = 0) {
        interval = 1.0 / Double(max(1, fps))
        credit = Self.burst * interval
        updated = now
    }

    mutating func reset(fps: Int, now: Double) {
        interval = 1.0 / Double(max(1, fps))
        credit = Self.burst * interval
        updated = now
    }

    mutating func setFPS(_ fps: Int, now: Double) {
        refill(now: now)
        interval = 1.0 / Double(max(1, fps))
        credit = min(credit, Self.burst * interval)
    }

    mutating func refill(now: Double) {
        guard now > updated else { return }
        credit = min(credit + (now - updated), Self.burst * interval)
        updated = now
    }

    func ready(now: Double) -> Bool {
        waitSeconds(now: now) == 0
    }

    mutating func spend(now: Double) {
        refill(now: now)
        credit = max(0, credit - interval)
    }

    func waitSeconds(now: Double) -> Double {
        let elapsed = max(0, now - updated)
        let available = min(credit + elapsed, Self.burst * interval)
        return available >= interval ? 0 : interval - available
    }
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
        data.withUnsafeBytes { raw in
            annexB(raw.bindMemory(to: UInt8.self), headerLength: headerLength, parameters: parameters)
        }
    }

    static func annexB(_ bytes: UnsafeBufferPointer<UInt8>, headerLength: Int, parameters: [Data]) -> Data? {
        guard (1...4).contains(headerLength), !bytes.isEmpty, let base = bytes.baseAddress else { return nil }
        let parameterBytes = parameters.reduce(0) { $0 + 4 + $1.count }
        // With 4-byte AVCC headers, Annex-B output is the exact same size as
        // the input; shorter headers add up to 3 bytes per NAL.
        var result = Data()
        result.reserveCapacity(parameterBytes + bytes.count + (headerLength < 4 ? 64 : 0))
        let marker: [UInt8] = [0, 0, 0, 1]
        for parameter in parameters { result.append(contentsOf: marker); result.append(parameter) }
        var offset = 0
        let total = bytes.count
        while offset < total {
            guard total - offset >= headerLength else { return nil }
            var length = 0
            for index in 0..<headerLength { length = length << 8 | Int(base[offset + index]) }
            offset += headerLength
            guard length > 0, length <= total - offset else { return nil }
            result.append(contentsOf: marker)
            result.append(base + offset, count: length)
            offset += length
        }
        return result
    }

    static func png(_ image: CVPixelBuffer, crop: CGRect? = nil) -> Data? {
        var cgImage: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(image, options: nil, imageOut: &cgImage) == noErr, let cgImage else { return nil }
        let target: CGImage
        if let crop {
            guard let cropped = cgImage.cropping(to: crop) else { return nil }
            target = cropped
        } else {
            target = cgImage
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, target, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    static func patchPayload(x: Int, y: Int, fullWidth: Int, fullHeight: Int, png: Data) -> Data {
        var payload = Data(capacity: 8 + png.count)
        for value in [UInt16(x), UInt16(y), UInt16(fullWidth), UInt16(fullHeight)] {
            var le = value.littleEndian
            withUnsafeBytes(of: &le) { payload.append(contentsOf: $0) }
        }
        payload.append(png)
        return payload
    }

    /// Bounding box of ScreenCaptureKit dirty rectangles in clamped pixel
    /// coordinates. Returns `nil` when dirty metadata is unavailable (full
    /// frame required) and `.zero` when nothing changed.
    static func dirtyUnion(_ dirtyRects: Any?, width: Int, height: Int) -> CGRect? {
        guard width > 0, height > 0 else { return nil }
        guard let rects = dirtyRects as? [Any] else { return nil }
        if rects.isEmpty { return .zero }
        var minX = Double(width), minY = Double(height), maxX = 0.0, maxY = 0.0
        for item in rects {
            let rect: CGRect
            if let value = item as? NSValue {
                rect = value.rectValue
            } else if CFGetTypeID(item as CFTypeRef) == CFDictionaryGetTypeID(),
                      let parsed = CGRect(dictionaryRepresentation: item as! CFDictionary) {
                rect = parsed
            } else {
                return nil
            }
            guard rect.origin.x.isFinite && rect.origin.y.isFinite && rect.width.isFinite && rect.height.isFinite else {
                return nil
            }
            guard rect.width > 0 && rect.height > 0 else { continue }
            let x0 = max(0, min(Double(width), floor(rect.minX)))
            let y0 = max(0, min(Double(height), floor(rect.minY)))
            let x1 = max(0, min(Double(width), ceil(rect.maxX)))
            let y1 = max(0, min(Double(height), ceil(rect.maxY)))
            if x1 > x0 && y1 > y0 {
                minX = min(minX, x0)
                minY = min(minY, y0)
                maxX = max(maxX, x1)
                maxY = max(maxY, y1)
            }
        }
        guard maxX > minX && maxY > minY else { return .zero }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    static func hasDirtyContent(_ dirtyRects: Any?) -> Bool {
        guard let rects = dirtyRects as? [Any] else { return true }
        if rects.isEmpty { return false }
        for item in rects {
            let rect: CGRect
            if let value = item as? NSValue {
                rect = value.rectValue
            } else if CFGetTypeID(item as CFTypeRef) == CFDictionaryGetTypeID(),
                      let parsed = CGRect(dictionaryRepresentation: item as! CFDictionary) {
                rect = parsed
            } else {
                return true
            }
            if rect.width.isFinite && rect.height.isFinite && rect.width > 0 && rect.height > 0 {
                return true
            }
        }
        return false
    }

    static func profileLevel(for profile: DisplayProfile) -> CFString {
        switch profile {
        case .constrainedHigh: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel
        case .main: kVTProfileLevel_H264_Main_AutoLevel
        case .constrainedBaseline: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel
        }
    }

    static func encoderSpecification() -> CFDictionary {
        [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
        ] as CFDictionary
    }

    static func configureEncoder(_ encoder: VTCompressionSession, fps: Int, bitrate: Int, profile: DisplayProfile = .constrainedBaseline) throws {
        let properties: [CFString: Any] = [
            kVTCompressionPropertyKey_ProfileLevel: profileLevel(for: profile),
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_AverageBitRate: bitrate,
            kVTCompressionPropertyKey_ExpectedFrameRate: fps,
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 30,
            kVTCompressionPropertyKey_ColorPrimaries: kCVImageBufferColorPrimaries_ITU_R_709_2,
            kVTCompressionPropertyKey_TransferFunction: kCVImageBufferTransferFunction_ITU_R_709_2,
            kVTCompressionPropertyKey_YCbCrMatrix: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        ]
        guard VTSessionSetProperties(encoder, propertyDictionary: properties as CFDictionary) == noErr else { throw DisplayError.encoder }
        if profile != .constrainedBaseline {
            VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_H264EntropyMode, value: kVTH264EntropyMode_CABAC)
        }
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_MaximumRealTimeFrameRate, value: fps as CFNumber)
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

    static func setRateLimit(_ encoder: VTCompressionSession, bitrate: Int, wide: Bool = false) {
        // AverageBitRate permits large spikes. Bound a one-second window
        // with room for an IDR; idle refinement passes get a wider budget.
        let numerator = wide ? 10 : 5
        let limit: [NSNumber] = [NSNumber(value: max(1, bitrate * numerator / 32)), NSNumber(value: 1.0)]
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
        var refinementInFlight = false
        var fps: Int
        var bitrate: Int
    }
    private let flags: Mutex<Flags>
    @MainActor private var stream: SCStream?
    /// Confined to the sample handler queue, including invalidation.
    private var encoder: VTCompressionSession?
    /// One scaled surface allows a fresh IDR after packet loss and idle
    /// paint-over refinement when the desktop settles.
    private var latestImage: CVPixelBuffer?
    private var latestTime = CMTime.invalid
    private var pendingImage = false
    private var lastEncodedTime = CMTime.invalid
    private var keyframeWorkQueued = false
    private var paceWorkQueued = false
    private var originalHasSent = false
    private var originalDirtyRect: CGRect?
    private var originalNeedsFull = true
    private var originalPendingImage: CVPixelBuffer?
    private var originalPendingTime = CMTime.invalid
    private var originalRetryQueued = false
    private var bucket: CaptureBucket
    private var wideRateLimit = false
    private var refinementToken: UInt64 = 0
    private var refinementPasses = 0
    private var firstRefinementSize = 0
    private static let refinementDelayMs = 180
    private static let maxRefinementPasses = 3

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
        bucket = CaptureBucket(fps: settings.fps, now: ProcessInfo.processInfo.systemUptime)
    }

    private func configuration(fps: Int) -> SCStreamConfiguration {
        let size = outputSize
        let config = SCStreamConfiguration()
        config.width = size.width
        config.height = size.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        config.queueDepth = 6
        config.pixelFormat = settings.original ? kCVPixelFormatType_32BGRA : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.colorSpaceName = settings.original ? CGColorSpace.sRGB : CGColorSpace.itur_709
        if !settings.original {
            config.colorMatrix = kCVImageBufferYCbCrMatrix_ITU_R_709_2
        }
        config.captureResolution = .best
        config.showsCursor = true
        config.capturesAudio = false
        config.captureMicrophone = false
        config.scalesToFit = true
        config.preservesAspectRatio = true
        return config
    }

    private var outputSize: (width: Int, height: Int) {
        DisplayVideo.size(width: sourcePixelWidth,
                          height: sourcePixelHeight,
                          maximum: settings.dimension, original: settings.original)
    }

    @MainActor func start() async throws {
        do {
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
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try await stream.startCapture()
            // A display reconfiguration can replace this capture without
            // changing the viewer's generation while startCapture is awaiting.
            if !gate.contains(generation) || flags.withLock({ $0.stopped }) || self.stream !== stream {
                try? await stream.stopCapture()
                await stop()
            }
        } catch {
            await stop()
            throw error
        }
    }

    @MainActor func stop() async {
        flags.withLock { $0.stopped = true }
        if let stream { try? await stream.stopCapture() }
        self.stream = nil
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
                self.paceWorkQueued = false
                self.originalHasSent = false
                self.originalDirtyRect = nil
                self.originalNeedsFull = true
                self.originalPendingImage = nil
                self.originalPendingTime = .invalid
                self.originalRetryQueued = false
                self.wideRateLimit = false
                self.refinementToken &+= 1
                self.refinementPasses = 0
                self.firstRefinementSize = 0
                continuation.resume()
            }
        }
    }

    @MainActor func configure(fps: Int, bitrate: Int) async {
        guard !settings.original, gate.contains(generation) else { return }
        flags.withLock { $0.fps = fps; $0.bitrate = bitrate }
        queue.async {
            guard let encoder = self.encoder, self.gate.contains(self.generation) else { return }
            let latest = self.flags.withLock { ($0.fps, $0.bitrate) }
            // Pace FPS in software via CaptureBucket instead of reconfiguring
            // SCStream surfaces, avoiding capture hitches on bitrate changes.
            self.bucket.setFPS(latest.0, now: ProcessInfo.processInfo.systemUptime)
            VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AverageBitRate, value: latest.1 as CFNumber)
            VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: latest.0 as CFNumber)
            DisplayVideo.setRateLimit(encoder, bitrate: latest.1, wide: self.wideRateLimit)
        }
    }

    func requestKeyframe() {
        guard !settings.original else { return }
        flags.withLock { $0.keyframe = true }
        queue.async {
            self.cancelRefinement()
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
        encode(latestImage, at: CMClockGetTime(CMClockGetHostTimeClock()), refinement: false)
    }

    private func cancelRefinement() {
        refinementToken &+= 1
        refinementPasses = 0
        firstRefinementSize = 0
        setWideRateLimit(false)
    }

    private func setWideRateLimit(_ wide: Bool) {
        guard wideRateLimit != wide, let encoder else { return }
        wideRateLimit = wide
        let bitrate = flags.withLock { $0.bitrate }
        DisplayVideo.setRateLimit(encoder, bitrate: bitrate, wide: wide)
    }

    private func scheduleRefinement(afterMs delay: Int) {
        refinementToken &+= 1
        let token = refinementToken
        queue.asyncAfter(deadline: .now() + .milliseconds(delay)) { [weak self] in
            self?.runRefinement(token: token)
        }
    }

    private func runRefinement(token: UInt64) {
        guard token == refinementToken, gate.contains(generation), !pendingImage,
              let latestImage, !flags.withLock({ $0.stopped || $0.keyframe }) else { return }
        if flags.withLock({ $0.encoding }) {
            queue.asyncAfter(deadline: .now() + .milliseconds(16)) { [weak self] in
                self?.runRefinement(token: token)
            }
            return
        }
        setWideRateLimit(true)
        encode(latestImage, at: CMClockGetTime(CMClockGetHostTimeClock()), refinement: true)
    }

    private func createEncoder() throws {
        guard gate.contains(generation) else { return }
        let size = outputSize
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(size.width), height: Int32(size.height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: DisplayVideo.encoderSpecification(),
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { context, _, status, infoFlags, sample in
                guard let context else { return }
                Unmanaged<DisplayCapture>.fromOpaque(context).takeUnretainedValue().encoded(status: status, infoFlags: infoFlags, sample: sample)
            }, refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &encoder)
        guard status == noErr, let encoder else { throw DisplayError.encoder }
        let latest = flags.withLock { ($0.fps, $0.bitrate) }
        try DisplayVideo.configureEncoder(encoder, fps: latest.0, bitrate: latest.1, profile: settings.profile)
        bucket.reset(fps: latest.0, now: ProcessInfo.processInfo.systemUptime)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, gate.contains(generation), !flags.withLock({ $0.stopped }), (settings.original || encoder != nil),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let value = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: value) else { return }
        switch status {
        case .complete, .started: break
        case .blank, .suspended, .stopped:
            fail("The selected display is no longer available. Wake or unlock the Mac, then start viewing again.")
            return
        default: return
        }
        guard sampleBuffer.isValid, let image = sampleBuffer.imageBuffer else { return }
        if settings.original {
            let width = CVPixelBufferGetWidth(image)
            let height = CVPixelBufferGetHeight(image)
            let rect = DisplayVideo.dirtyUnion(attachments.first?[.dirtyRects], width: width, height: height)
            if rect == .zero && originalHasSent && originalDirtyRect == nil && !originalNeedsFull { return }
            if !originalHasSent || rect == nil {
                originalNeedsFull = true
                originalDirtyRect = nil
            } else if !originalNeedsFull, let rect, rect != .zero {
                originalDirtyRect = originalDirtyRect.map { $0.union(rect) } ?? rect
            }
            originalPendingImage = image
            originalPendingTime = sampleBuffer.presentationTimeStamp
            sendPendingOriginal()
            return
        }
        let dirty = DisplayVideo.hasDirtyContent(attachments.first?[.dirtyRects])
        if !dirty && latestImage != nil { return }
        cancelRefinement()
        latestImage = image
        latestTime = sampleBuffer.presentationTimeStamp
        pendingImage = true
        encodePendingImage()
    }

    private func sendPendingOriginal() {
        guard gate.contains(generation), !flags.withLock({ $0.stopped }), let image = originalPendingImage else { return }
        let width = CVPixelBufferGetWidth(image)
        let height = CVPixelBufferGetHeight(image)
        guard width > 0, height > 0 else { return }
        let seconds = CMTimeGetSeconds(originalPendingTime)
        guard seconds.isFinite, seconds >= 0 else { return }

        let sendFull: Bool
        let crop: CGRect?
        if !originalHasSent || originalNeedsFull {
            sendFull = true
            crop = nil
        } else if let dirty = originalDirtyRect {
            let areaRatio = (dirty.width * dirty.height) / Double(width * height)
            if areaRatio > 0.55 || (Int(dirty.width) >= width && Int(dirty.height) >= height) {
                sendFull = true
                crop = nil
            } else {
                sendFull = false
                crop = dirty
            }
        } else {
            return
        }

        guard let png = autoreleasepool(invoking: { DisplayVideo.png(image, crop: crop) }) else {
            fail("The HD picture could not be prepared. Try Sharper text or start viewing again.")
            return
        }
        guard gate.contains(generation) else { return }
        let payload: Data
        if sendFull {
            payload = png
        } else if let crop {
            payload = DisplayVideo.patchPayload(
                x: Int(crop.minX), y: Int(crop.minY),
                fullWidth: width, fullHeight: height, png: png
            )
        } else {
            return
        }
        guard payload.count <= 16 * 1024 * 1024 else { fail("This HD picture is too large. Choose Sharper text for this screen content."); return }
        if sendFrame(payload, UInt64(seconds * 1_000_000), sendFull) {
            originalHasSent = true
            originalNeedsFull = false
            originalDirtyRect = nil
            originalPendingImage = nil
        } else if !originalRetryQueued {
            // Transport is still sending a previous patch/picture; keep the
            // accumulated dirty rect so no changed pixels are lost and retry shortly.
            originalRetryQueued = true
            queue.asyncAfter(deadline: .now() + .milliseconds(60)) { [weak self] in
                guard let self else { return }
                self.originalRetryQueued = false
                self.sendPendingOriginal()
            }
        }
    }

    private func encodePendingImage() {
        guard pendingImage, let latestImage, !flags.withLock({ $0.encoding || $0.stopped }), gate.contains(generation) else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let forceKey = flags.withLock { $0.keyframe }
        if !forceKey && !bucket.ready(now: now) {
            guard !paceWorkQueued else { return }
            paceWorkQueued = true
            let waitMs = max(1, Int((bucket.waitSeconds(now: now) * 1000).rounded(.up)))
            queue.asyncAfter(deadline: .now() + .milliseconds(waitMs)) { [weak self] in
                guard let self else { return }
                self.paceWorkQueued = false
                self.encodePendingImage()
            }
            return
        }
        bucket.spend(now: now)
        pendingImage = false
        setWideRateLimit(forceKey)
        encode(latestImage, at: latestTime, refinement: false)
    }

    private func encode(_ image: CVPixelBuffer, at time: CMTime, refinement: Bool) {
        guard gate.contains(generation), let encoder else { return }
        let force: Bool? = flags.withLock {
            guard !$0.stopped, !$0.encoding else { return nil }
            $0.encoding = true
            let keyframe = !refinement && $0.keyframe
            if keyframe { $0.keyframe = false }
            $0.forcedKeyframeInFlight = keyframe
            $0.refinementInFlight = refinement
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
            flags.withLock { $0.encoding = false; $0.refinementInFlight = false }
            fail("Hardware video encoding stopped. Try starting the view again.")
        }
    }

    private func encoded(status: OSStatus, infoFlags: VTEncodeInfoFlags, sample: CMSampleBuffer?) {
        let wasRefinement = flags.withLock { $0.refinementInFlight }
        var sentBytes: Int?
        defer {
            let emitted = sentBytes
            flags.withLock { $0.encoding = false; $0.refinementInFlight = false }
            // Drain the newest pending frame even when screen motion ends
            // while an earlier frame is still being encoded.
            queue.async {
                if let emitted {
                    self.afterEncoded(wasRefinement: wasRefinement, bytes: emitted)
                }
                self.encodePendingImage()
            }
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
        let seconds = CMTimeGetSeconds(sample.presentationTimeStamp)
        guard seconds.isFinite, seconds >= 0 else { requestKeyframe(); return }
        var lengthAtOffset = 0
        var totalLength = 0
        var pointer: UnsafeMutablePointer<CChar>?
        let annexB: Data?
        if CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset, totalLengthOut: &totalLength, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
           let pointer, lengthAtOffset == length {
            annexB = pointer.withMemoryRebound(to: UInt8.self, capacity: length) {
                DisplayVideo.annexB(UnsafeBufferPointer(start: $0, count: length), headerLength: Int(headerLength), parameters: parameters)
            }
        } else {
            var data = Data(count: length)
            let copied = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
            annexB = copied == noErr ? DisplayVideo.annexB(data, headerLength: Int(headerLength), parameters: parameters) : nil
        }
        guard let annexB else { requestKeyframe(); return }
        guard annexB.count <= 1024 * 1024 else { fail("This frame could not be streamed at the selected quality. Choose Save battery and try again."); return }
        if !sendFrame(annexB, UInt64(seconds * 1_000_000), keyframe) {
            requestKeyframe()
        } else {
            sentBytes = annexB.count
        }
    }

    private func afterEncoded(wasRefinement: Bool, bytes: Int) {
        guard gate.contains(generation), !flags.withLock({ $0.stopped }) else { return }
        if pendingImage {
            setWideRateLimit(false)
            return
        }
        let latest = flags.withLock { ($0.fps, $0.bitrate) }
        if wasRefinement {
            if refinementPasses == 0 { firstRefinementSize = bytes }
            refinementPasses += 1
            let smallEnough = bytes <= max(1024, latest.1 / (32 * max(1, latest.0)))
            let converged = smallEnough || bytes * 4 <= firstRefinementSize || refinementPasses >= Self.maxRefinementPasses
            if converged {
                setWideRateLimit(false)
            } else {
                let paceMs = max(33, 1000 / max(1, latest.0))
                scheduleRefinement(afterMs: paceMs)
            }
        } else {
            setWideRateLimit(false)
            refinementPasses = 0
            firstRefinementSize = 0
            scheduleRefinement(afterMs: Self.refinementDelayMs)
        }
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
