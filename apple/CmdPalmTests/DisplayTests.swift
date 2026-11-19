import Foundation
import CoreMedia
import CoreVideo
import Darwin
import Testing
import VideoToolbox
import ImageIO
@testable import CmdPalm

@Suite struct DisplayVideoTests {
    @Test func sourcePixelSizeUsesTheSelectedDisplaysScaleAndOrientation() {
        let retina = DisplayVideo.pixelSize(width: 1440, height: 900, scale: 2)
        #expect(retina.width == 2880 && retina.height == 1800)
        let portrait = DisplayVideo.pixelSize(width: 1080, height: 1920, scale: 2)
        #expect(portrait.width == 2160 && portrait.height == 3840)
        let ordinary = DisplayVideo.pixelSize(width: 1920, height: 1080, scale: 1)
        #expect(ordinary.width == 1920 && ordinary.height == 1080)
        let invalid = DisplayVideo.pixelSize(width: 1920, height: .infinity, scale: .nan)
        #expect(invalid.width == 1920 && invalid.height == 2)
    }

    @Test func originalPicturesPreserveSourcePixelsWithoutTheVideoLevelLimit() throws {
        let size = DisplayVideo.size(width: 1920, height: 1080, maximum: 3840, original: true)
        #expect(size.width == 1920 && size.height == 1080)
        let capped = DisplayVideo.size(width: 5120, height: 2880, maximum: 3840, original: true)
        #expect(capped.width == 3840 && capped.height == 2160)
        var buffer: CVPixelBuffer?
        let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        #expect(CVPixelBufferCreate(nil, 64, 32, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &buffer) == kCVReturnSuccess)
        let image = try #require(buffer)
        #expect(CVPixelBufferLockBaseAddress(image, []) == kCVReturnSuccess)
        let base = try #require(CVPixelBufferGetBaseAddress(image))
        let stride = CVPixelBufferGetBytesPerRow(image)
        for y in 0..<32 {
            for x in 0..<64 {
                let pixel = base.advanced(by: y * stride + x * 4).assumingMemoryBound(to: UInt8.self)
                let shade: UInt8 = x.isMultiple(of: 2) ? 0 : 255
                pixel[0] = shade; pixel[1] = shade; pixel[2] = shade; pixel[3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(image, [])
        let png = try #require(DisplayVideo.png(image))
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        let decoded = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        #expect(decoded.width == 64 && decoded.height == 32)
        var pixels = [UInt8](repeating: 0, count: 64 * 32 * 4)
        pixels.withUnsafeMutableBytes { bytes in
            let context = CGContext(data: bytes.baseAddress, width: 64, height: 32, bitsPerComponent: 8, bytesPerRow: 64 * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(decoded, in: CGRect(x: 0, y: 0, width: 64, height: 32))
        }
        for x in 0..<64 {
            #expect(pixels[x * 4] == (x.isMultiple(of: 2) ? 0 : 255), "One-pixel text edges must survive PNG encoding exactly.")
        }
    }
    @Test func sizesStayEvenBoundedAndCloseToTheSourceAspect() {
        let cases: [(width: Int, height: Int, maximum: Int)] = [
            (2560, 1440, 1920),       // landscape
            (1170, 2532, 1920),       // portrait Retina
            (2880, 1800, 1920),       // Retina landscape
            (3440, 1440, 1920),       // ultrawide
            (1365, 767, 1200),        // odd dimensions
            (1920, 1080, 5000),       // maximum edge is capped
            (1920, 1080, 300),        // maximum edge is clamped upward
        ]

        for source in cases {
            let output = DisplayVideo.size(width: source.width, height: source.height, maximum: source.maximum)
            let edgeCap = min(max(source.maximum, 352), 1920)
            let shortEdgeCap = edgeCap * 9 / 16
            let longEdge = max(output.width, output.height)
            let shortEdge = min(output.width, output.height)

            #expect(output.width > 0 && output.height > 0)
            #expect(output.width.isMultiple(of: 2) && output.height.isMultiple(of: 2))
            #expect(output.width <= source.width && output.height <= source.height)
            #expect(longEdge <= edgeCap)
            #expect(shortEdge <= shortEdgeCap)
            // Even-pixel rounding can move an edge by at most a few pixels.
            #expect(abs(output.width * source.height - output.height * source.width) <= 2 * (source.width + source.height))
        }
    }

    @Test func invalidSourceDimensionsReturnAValidFallback() {
        for source in [(0, 1080), (-1, 1080), (1920, 0), (1920, -1)] {
            let output = DisplayVideo.size(width: source.0, height: source.1, maximum: 1280)
            #expect(output.width == 2 && output.height == 2)
            #expect(output.width.isMultiple(of: 2) && output.height.isMultiple(of: 2))
        }
    }

    @Test func convertsLengthPrefixedNalsAndPrependsParameterSetsInOrder() {
        let parameters = [Data([0x67, 0x64]), Data([0x68, 0xee])]
        let expected = Data([
            0, 0, 0, 1, 0x67, 0x64,
            0, 0, 0, 1, 0x68, 0xee,
            0, 0, 0, 1, 0x65, 0x88,
            0, 0, 0, 1, 0x41,
        ])

        #expect(DisplayVideo.annexB(Data([2, 0x65, 0x88, 1, 0x41]), headerLength: 1, parameters: parameters) == expected)
        #expect(DisplayVideo.annexB(Data([0, 2, 0x65, 0x88, 0, 1, 0x41]), headerLength: 2, parameters: []) == Data([
            0, 0, 0, 1, 0x65, 0x88, 0, 0, 0, 1, 0x41,
        ]))
        #expect(DisplayVideo.annexB(Data([0, 0, 0, 2, 0x65, 0x88]), headerLength: 4, parameters: []) == Data([
            0, 0, 0, 1, 0x65, 0x88,
        ]))
    }

    @Test func rejectsMalformedLengthPrefixedNals() {
        #expect(DisplayVideo.annexB(Data(), headerLength: 1, parameters: []) == nil)
        #expect(DisplayVideo.annexB(Data([0]), headerLength: 2, parameters: []) == nil) // truncated header
        #expect(DisplayVideo.annexB(Data([0]), headerLength: 1, parameters: []) == nil) // zero-length NAL
        #expect(DisplayVideo.annexB(Data([3, 0x65, 0x88]), headerLength: 1, parameters: []) == nil) // declared length exceeds remaining data
        #expect(DisplayVideo.annexB(Data([0, 0, 0, 0, 0]), headerLength: 5, parameters: []) == nil)
        #expect(DisplayVideo.annexB(Data([0]), headerLength: 0, parameters: []) == nil)
    }

    @Test func dirtyRectDetectionSkipsEmptyAndZeroAreaUpdates() {
        #expect(DisplayVideo.hasDirtyContent(nil))
        #expect(!DisplayVideo.hasDirtyContent([] as [Any]))
        #expect(!DisplayVideo.hasDirtyContent([NSValue(rect: .zero)]))
        #expect(!DisplayVideo.hasDirtyContent([CGRect.zero.dictionaryRepresentation]))
        #expect(DisplayVideo.hasDirtyContent([NSValue(rect: NSRect(x: 10, y: 20, width: 32, height: 16))]))
        #expect(DisplayVideo.hasDirtyContent([CGRect(x: 0, y: 0, width: 4, height: 4).dictionaryRepresentation]))
    }

    @Test func captureBucketAllowsTwoFrameBurstThenPacesAtConfiguredFps() {
        var bucket = CaptureBucket(fps: 60, now: 10.0)
        #expect(bucket.ready(now: 10.0))
        bucket.spend(now: 10.0)
        #expect(bucket.ready(now: 10.0))
        bucket.spend(now: 10.0)
        #expect(!bucket.ready(now: 10.0))
        #expect(bucket.waitSeconds(now: 10.0) > 0.015)

        let nextFrame = 10.0 + (1.0 / 60.0) + 0.0001
        #expect(bucket.ready(now: nextFrame))
        bucket.spend(now: nextFrame)
        #expect(!bucket.ready(now: nextFrame))

        bucket.setFPS(30, now: nextFrame + 1.0)
        #expect(bucket.ready(now: nextFrame + 1.0))
        bucket.spend(now: nextFrame + 1.0)
        bucket.spend(now: nextFrame + 1.0)
        #expect(!bucket.ready(now: nextFrame + 1.0))
        #expect(bucket.waitSeconds(now: nextFrame + 1.0) > 0.032)
    }
}

@Suite struct DisplayGateTests {
    @Test func aStoppedGenerationCannotStartAgain() {
        let gate = DisplayGate()
        #expect(gate.begin(10))
        #expect(gate.contains(10))

        gate.end(10)

        #expect(!gate.contains(10))
        #expect(!gate.begin(10))
    }

    @Test func aLateStopForAnOldGenerationDoesNotEndTheNewOne() {
        let gate = DisplayGate()
        #expect(gate.begin(10))
        #expect(gate.begin(11))

        gate.end(10)

        #expect(gate.contains(11))
        #expect(!gate.begin(9))
    }

    @Test func stoppingANewerGenerationAlsoInvalidatesAnOlderPendingCapture() {
        let gate = DisplayGate()
        #expect(gate.begin(10))
        gate.end(12)
        #expect(!gate.contains(10))
        #expect(!gate.begin(12))
        #expect(gate.begin(13))
    }

    @Test func suspensionRequiresAnewGenerationAfterResume() {
        let gate = DisplayGate()
        #expect(gate.begin(20))
        gate.suspend(true, reason: "sleep")
        #expect(!gate.contains(20))

        gate.suspend(false, reason: "sleep")

        #expect(!gate.begin(20))
        #expect(gate.begin(21))
        #expect(gate.contains(21))
    }

    @Test func eachSuspensionReasonMustClearBeforeStartingAgain() {
        let gate = DisplayGate()
        gate.suspend(true, reason: "sleep")
        gate.suspend(true, reason: "lock")
        gate.suspend(false, reason: "sleep")

        #expect(!gate.begin(30))
        gate.suspend(false, reason: "lock")

        #expect(gate.begin(30))
    }
}

private struct EncoderCallbackResult: Sendable {
    let status: OSStatus
    let sps: Data?
}

private final class EncoderCallbackProbe: @unchecked Sendable {
    private let condition = NSCondition()
    private var result: EncoderCallbackResult?

    func record(status: OSStatus, sps: Data?) {
        condition.lock()
        if result == nil {
            result = EncoderCallbackResult(status: status, sps: sps)
            condition.broadcast()
        }
        condition.unlock()
    }

    func wait(timeout: TimeInterval) -> EncoderCallbackResult? {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(timeout)
        while result == nil {
            if !condition.wait(until: deadline) { break }
        }
        return result
    }
}

private enum EncoderSmokeError: Error, CustomStringConvertible {
    case create(OSStatus)
    case configure(String)
    case pixelBuffer(OSStatus)
    case pixelBufferLock(OSStatus)
    case encode(OSStatus)
    case callbackTimeout

    var description: String {
        switch self {
        case let .create(status): "hardware encoder creation failed with status \(status)"
        case let .configure(message): "production encoder configuration failed: \(message)"
        case let .pixelBuffer(status): "NV12 pixel buffer creation failed with status \(status)"
        case let .pixelBufferLock(status): "NV12 pixel buffer lock failed with status \(status)"
        case let .encode(status): "single-frame encode submission failed with status \(status)"
        case .callbackTimeout: "hardware encoder did not emit a sample callback within three seconds"
        }
    }
}

private func h264SPS(from sampleBuffer: CMSampleBuffer?) -> Data? {
    guard let sampleBuffer, let description = CMSampleBufferGetFormatDescription(sampleBuffer) else { return nil }
    var pointer: UnsafePointer<UInt8>?
    var size = 0
    var count = 0
    var headerLength: Int32 = 0
    let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        description,
        parameterSetIndex: 0,
        parameterSetPointerOut: &pointer,
        parameterSetSizeOut: &size,
        parameterSetCountOut: &count,
        nalUnitHeaderLengthOut: &headerLength,
    )
    guard status == noErr, let pointer, size > 0 else { return nil }
    return Data(bytes: pointer, count: size)
}

private func grayNV12(width: Int, height: Int) throws -> CVPixelBuffer {
    let attributes: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    var pixelBuffer: CVPixelBuffer?
    let createStatus = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        attributes as CFDictionary,
        &pixelBuffer,
    )
    guard createStatus == noErr, let pixelBuffer else { throw EncoderSmokeError.pixelBuffer(createStatus) }

    let lockStatus = CVPixelBufferLockBaseAddress(pixelBuffer, [])
    guard lockStatus == kCVReturnSuccess else { throw EncoderSmokeError.pixelBufferLock(lockStatus) }
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
    for plane in 0..<CVPixelBufferGetPlaneCount(pixelBuffer) {
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, plane) else {
            throw EncoderSmokeError.pixelBuffer(kCVReturnError)
        }
        let bytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, plane) * CVPixelBufferGetHeightOfPlane(pixelBuffer, plane)
        _ = memset(base, 128, bytes)
    }
    return pixelBuffer
}

private func encodeOneGrayFrame(maxDimension: Int, fps: Int, bitrate: Int, profile: DisplayProfile = .constrainedBaseline) throws -> EncoderCallbackResult {
    let size = DisplayVideo.size(width: 2560, height: 1600, maximum: maxDimension)
    let pixelBuffer = try grayNV12(width: size.width, height: size.height)
    let probe = EncoderCallbackProbe()
    let callbackContext = Unmanaged.passRetained(probe)
    var encoder: VTCompressionSession?
    let createStatus = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(size.width),
        height: Int32(size.height),
        codecType: kCMVideoCodecType_H264,
        encoderSpecification: DisplayVideo.encoderSpecification(),
        imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: { context, _, status, _, sampleBuffer in
            guard let context else { return }
            let probe = Unmanaged<EncoderCallbackProbe>.fromOpaque(context).takeUnretainedValue()
            probe.record(status: status, sps: status == noErr ? h264SPS(from: sampleBuffer) : nil)
        },
        refcon: callbackContext.toOpaque(),
        compressionSessionOut: &encoder,
    )
    guard createStatus == noErr, let encoder else {
        if let encoder { VTCompressionSessionInvalidate(encoder) }
        callbackContext.release()
        throw EncoderSmokeError.create(createStatus)
    }
    defer {
        VTCompressionSessionInvalidate(encoder)
        callbackContext.release()
    }

    do {
        try DisplayVideo.configureEncoder(encoder, fps: fps, bitrate: bitrate, profile: profile)
        var rateLimits: Unmanaged<CFTypeRef>?
        let status = VTSessionCopyProperty(encoder, key: kVTCompressionPropertyKey_DataRateLimits, allocator: nil, valueOut: &rateLimits)
        let limits = rateLimits?.takeRetainedValue() as? [NSNumber]
        #expect(status == noErr)
        #expect(limits?.first?.intValue == bitrate * 5 / 32, "The hardware encoder must accept the one-second burst limit.")
    } catch {
        throw EncoderSmokeError.configure(String(describing: error))
    }
    let forceKeyFrame = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
    let encodeStatus = VTCompressionSessionEncodeFrame(
        encoder,
        imageBuffer: pixelBuffer,
        presentationTimeStamp: .zero,
        duration: .invalid,
        frameProperties: forceKeyFrame,
        sourceFrameRefcon: nil,
        infoFlagsOut: nil,
    )
    guard encodeStatus == noErr else { throw EncoderSmokeError.encode(encodeStatus) }
    guard let callback = probe.wait(timeout: 3) else { throw EncoderSmokeError.callbackTimeout }
    return callback
}

@Suite(.serialized) struct DisplayHardwareEncoderSmokeTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CMDPALM_TEST_HARDWARE_VIDEO"] == "1"))
    func emitsFirstFrameAcrossNegotiatedProfilesWithoutWaitingForAnotherFrame() {
        let cases: [(maximum: Int, fps: Int, bitrate: Int, maxLevel: UInt8, profile: DisplayProfile, profileIdc: UInt8)] = [
            (maximum: 896, fps: 60, bitrate: 4_500_000, maxLevel: 31, profile: .constrainedBaseline, profileIdc: 66),
            (maximum: 1280, fps: 60, bitrate: 8_000_000, maxLevel: 32, profile: .main, profileIdc: 77),
            (maximum: 960, fps: 30, bitrate: 2_000_000, maxLevel: 31, profile: .constrainedBaseline, profileIdc: 66),
            (maximum: 1920, fps: 30, bitrate: 12_000_000, maxLevel: 40, profile: .constrainedHigh, profileIdc: 100),
        ]
        for testCase in cases {
            do {
                let callback = try encodeOneGrayFrame(maxDimension: testCase.maximum, fps: testCase.fps, bitrate: testCase.bitrate, profile: testCase.profile)
                #expect(callback.status == noErr)
                guard callback.status == noErr, let sps = callback.sps, sps.count >= 4 else {
                    Issue.record("The hardware encoder callback did not contain a valid H.264 SPS for max dimension \(testCase.maximum).")
                    continue
                }
                let bytes = [UInt8](sps)
                #expect(bytes[1] == testCase.profileIdc, "Expected H.264 profile_idc \(testCase.profileIdc) for \(testCase.profile).")
                if testCase.profile == .constrainedBaseline {
                    #expect(bytes[2] & 0xc0 == 0xc0, "Expected baseline and constrained-baseline SPS flags.")
                }
                #expect(bytes[3] <= testCase.maxLevel, "The encoder exceeded the negotiated H.264 level ceiling.")
            } catch {
                Issue.record("Hardware encoder smoke failed for max dimension \(testCase.maximum): \(error)")
            }
        }
    }
}
