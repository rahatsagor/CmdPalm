import AudioToolbox
import CoreAudio
import Foundation
import Synchronization

/// Output volume of the default audio device, through Core Audio.
final class AudioVolume: Sendable {
    struct State: Equatable, Sendable {
        var value: Float
        var muted: Bool
    }

    private let queue = DispatchQueue(label: "app.cmdpalm.volume")
    private let device = Mutex<AudioObjectID>(AudioObjectID(kAudioObjectUnknown))
    private let listened = Mutex<Set<AudioObjectID>>([])
    /// Receives nil when the output device has no software volume (HDMI, some USB DACs).
    private let onChange: @Sendable (State?) -> Void

    init(onChange: @escaping @Sendable (State?) -> Void) {
        self.onChange = onChange
    }

    /// Start reporting changes, including switches to another output device.
    func start() {
        var address = Self.address(kAudioHardwarePropertyDefaultOutputDevice, scope: kAudioObjectPropertyScopeGlobal)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue) { [weak self] _, _ in
            self?.attach()
        }
        queue.async { [weak self] in self?.attach() }
    }

    func current() -> State? {
        let id = Self.defaultDevice()
        guard id != kAudioObjectUnknown, let value = Self.volume(of: id) else { return nil }
        return State(value: value, muted: Self.muted(id) ?? false)
    }

    func set(value: Float?, muted: Bool?) {
        let id = Self.defaultDevice()
        guard id != kAudioObjectUnknown else { return }
        if let value {
            var scalar = Float32(min(max(value, 0), 1))
            var address = Self.address(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
            if AudioObjectHasProperty(id, &address) {
                AudioObjectSetPropertyData(id, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &scalar)
            } else {
                for channel in Self.channels(of: id) {
                    var channelAddress = Self.address(kAudioDevicePropertyVolumeScalar, element: channel)
                    AudioObjectSetPropertyData(id, &channelAddress, 0, nil, UInt32(MemoryLayout<Float32>.size), &scalar)
                }
            }
            // Moving the slider up should be audible even when muted.
            if muted == nil, scalar > 0, Self.muted(id) == true { Self.setMuted(id, false) }
        }
        if let muted { Self.setMuted(id, muted) }
    }

    private func attach() {
        let id = Self.defaultDevice()
        device.withLock { $0 = id }
        // Listeners on devices that are no longer the default stay registered
        // (removing needs the original block); `report` ignores them.
        let isNew = listened.withLock { $0.insert(id).inserted }
        if isNew, id != kAudioObjectUnknown {
            for selector in [kAudioHardwareServiceDeviceProperty_VirtualMainVolume, kAudioDevicePropertyMute] {
                var address = Self.address(selector)
                guard AudioObjectHasProperty(id, &address) else { continue }
                AudioObjectAddPropertyListenerBlock(id, &address, queue) { [weak self] _, _ in
                    self?.report(from: id)
                }
            }
        }
        report(from: id)
    }

    private func report(from id: AudioObjectID) {
        guard device.withLock({ $0 }) == id else { return }
        onChange(current())
    }

    // MARK: Core Audio helpers

    private static func address(
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioDevicePropertyScopeOutput,
        element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }

    private static func defaultDevice() -> AudioObjectID {
        var id = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = address(kAudioHardwarePropertyDefaultOutputDevice, scope: kAudioObjectPropertyScopeGlobal)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
        return status == noErr ? id : AudioObjectID(kAudioObjectUnknown)
    }

    private static func channels(of id: AudioObjectID) -> [AudioObjectPropertyElement] {
        [1, 2].filter { channel in
            var address = address(kAudioDevicePropertyVolumeScalar, element: channel)
            return AudioObjectHasProperty(id, &address)
        }
    }

    private static func volume(of id: AudioObjectID) -> Float? {
        var address = address(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
        if AudioObjectHasProperty(id, &address) {
            return float(id, &address)
        }
        let values = channels(of: id).compactMap { channel -> Float? in
            var channelAddress = Self.address(kAudioDevicePropertyVolumeScalar, element: channel)
            return float(id, &channelAddress)
        }
        return values.isEmpty ? nil : values.reduce(0, +) / Float(values.count)
    }

    private static func float(_ id: AudioObjectID, _ address: inout AudioObjectPropertyAddress) -> Float? {
        var value = Float32(0)
        var size = UInt32(MemoryLayout<Float32>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func muted(_ id: AudioObjectID) -> Bool? {
        var address = address(kAudioDevicePropertyMute)
        guard AudioObjectHasProperty(id, &address) else { return nil }
        var value = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr ? value != 0 : nil
    }

    private static func setMuted(_ id: AudioObjectID, _ muted: Bool) {
        var address = address(kAudioDevicePropertyMute)
        guard AudioObjectHasProperty(id, &address) else { return }
        var value = UInt32(muted ? 1 : 0)
        AudioObjectSetPropertyData(id, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value)
    }
}
