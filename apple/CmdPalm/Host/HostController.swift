import AppKit
import Network
import Observation

/// Owns the core host and mirrors its state for the UI.
@MainActor
@Observable
final class HostController {
    enum Status: Equatable {
        case starting
        case running(port: UInt16)
        case stopped
        case failed(String)
    }

    private(set) var status: Status = .stopped
    private(set) var pairing: PairingInfo?
    private(set) var pairingExpiry = Date.distantPast
    private(set) var connected: [ConnectedDevice] = []
    private(set) var trusted: [TrustedDevice] = []
    private(set) var approvals: [ApprovalRequest] = []
    private(set) var paused = false
    private(set) var preferredPortTaken = false
    private(set) var layoutName = ""
    /// The latest message for the person at the Mac, such as a missing permission.
    var notice: String?
    /// Name of the most recently paired device, for the welcome guide.
    private(set) var lastPaired: String?

    let preferences: Preferences
    let permissions: Permissions

    @ObservationIgnored private let reference = HostReference()
    @ObservationIgnored private var host: CoreHost!
    @ObservationIgnored private var bridge: HostBridge!
    @ObservationIgnored private var configuredPort: Int
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var appsChanged: DispatchWorkItem?
    @ObservationIgnored private var pairingTimer: Timer?
    @ObservationIgnored private var pinViews = 0
    /// Starts, stops and restarts run one after another, so two quick
    /// restarts can't interleave and leave the server on an old setting.
    @ObservationIgnored private var lifecycle: Task<Void, Never>?
    @ObservationIgnored private let network = NWPathMonitor()
    @ObservationIgnored var onApprovalsChanged: (() -> Void)?

    init(preferences: Preferences, permissions: Permissions) {
        self.preferences = preferences
        self.permissions = permissions
        configuredPort = preferences.port

        let reference = reference
        let volume = AudioVolume { state in
            if let state {
                reference.host?.setVolumeState(value: state.value, muted: state.muted)
            } else {
                reference.host?.clearVolumeState()
            }
        }
        let speech = SpeechService { session, update in
            reference.host?.voiceUpdate(session: session, update: update)
        }
        bridge = HostBridge(apps: AppCatalog(), volume: volume, pasteboard: Pasteboard(), speech: speech) { [weak self] event in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.handle(event) }
            }
        }
        bridge.setAllowsShell(preferences.allowShell)
        try? FileManager.default.createDirectory(at: SystemInfo.dataDirectory, withIntermediateDirectories: true)
        host = CoreHost(config: makeConfig(), delegate: bridge)
        reference.host = host

        bridge.apps.setCustomFolders(preferences.appFolders)
        preferences.onChange = { [weak self] in self?.preferencesChanged() }
        preferences.onAppFoldersChange = { [weak self] in
            guard let self else { return }
            bridge.apps.setCustomFolders(self.preferences.appFolders)
            appsDidChange(rescan: true)
        }
        permissions.onChange = { [weak self] in self?.permissionsChanged() }
        observeSystem()
        volume.start()
        trusted = host.trustedDevices()
    }

    var isRunning: Bool {
        if case .running = status { return true }
        return false
    }

    private var hasFailed: Bool {
        if case .failed = status { return true }
        return false
    }

    var port: UInt16? {
        if case let .running(port) = status { return port }
        return nil
    }

    // MARK: Lifecycle

    func start() {
        guard !host.isRunning() else { return }
        launch { host in _ = try host.start() }
    }

    func stop() {
        enqueue { host in host.stop() }
    }

    func restart() {
        configuredPort = preferences.port
        // Applied now, not by the queued task: the port only takes effect at
        // start, and a config captured for later would undo settings changed
        // while the server restarts, such as turning shell commands off.
        host.updateConfig(config: makeConfig())
        launch { host in
            host.stop()
            _ = try host.start()
        }
    }

    private func launch(_ work: @escaping @Sendable (CoreHost) throws -> Void) {
        status = .starting
        enqueue(work)
    }

    private func enqueue(_ work: @escaping @Sendable (CoreHost) throws -> Void) {
        let host = host!
        let previous = lifecycle
        lifecycle = Task.detached {
            await previous?.value
            do {
                try work(host)
            } catch {
                let message = (error as? HostError).map { if case let .Failed(message) = $0 { message } else { "\($0)" } }
                    ?? error.localizedDescription
                await MainActor.run { [weak self] in
                    // The Stopped event from a restart can land before this.
                    if let self, !self.isRunning { self.status = .failed(message) }
                }
            }
        }
    }

    /// Views showing the PIN report here; the core only accepts the PIN while
    /// one is on screen, and for a few minutes after.
    func pinShown(_ shown: Bool) {
        pinViews = max(0, pinViews + (shown ? 1 : -1))
        host.setPinShown(shown: pinViews > 0)
    }

    /// Stops serving and releases anything the phone was holding down, before
    /// the app quits.
    func shutdown() {
        network.cancel()
        host.stop()
    }

    // MARK: Actions

    func setPaused(_ paused: Bool) {
        host.setPaused(paused: paused)
        self.paused = host.isPaused()
    }

    func refreshPairing() {
        let info = host.pairingInfo()
        pairing = info
        pairingExpiry = Date().addingTimeInterval(TimeInterval(info.expiresInSecs))
        schedulePairingRefresh(after: TimeInterval(info.expiresInSecs))
    }

    func renewPairing() {
        host.renewPairing()
        refreshPairing()
    }

    func respond(to request: ApprovalRequest, allow: Bool) {
        host.respondApproval(id: request.id, allow: allow)
        removeApproval(request.id)
    }

    func disconnect(_ device: ConnectedDevice) {
        host.disconnect(session: device.session)
    }

    func forget(_ device: TrustedDevice) {
        host.forgetDevice(id: device.id)
    }

    func forgetAllDevices() {
        host.forgetAllDevices()
    }

    func rename(_ device: TrustedDevice, to name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != device.name else { return }
        host.renameDevice(id: device.id, name: name)
    }

    func deckJSON() -> String { host.deckJson() }

    func importDeck(_ json: String) throws {
        try host.setDeckJson(json: json)
    }

    func resetDeck() { host.resetDeck() }

    func certificate() -> Data { host.caCertificate() }

    // MARK: Events

    private func handle(_ event: HostEvent) {
        switch event {
        case let .started(port, taken):
            status = .running(port: port)
            preferredPortTaken = taken
            paused = host.isPaused()
            host.setPinShown(shown: pinViews > 0)
            refreshPairing()
            sendSystemState()
        case .stopped:
            status = .stopped
            connected = []
            if !approvals.isEmpty {
                approvals = []
                onApprovalsChanged?()
            }
        case let .failed(message):
            status = .failed(message)
        case .sessionsChanged:
            connected = host.connectedDevices()
            // People change key repeat in System Settings while connected.
            sendInputTiming()
        case .devicesChanged:
            trusted = host.trustedDevices()
            connected = host.connectedDevices()
        case .pairingChanged:
            refreshPairing()
        case let .approvalRequested(request):
            approvals.removeAll { $0.id == request.id }
            approvals.append(request)
            onApprovalsChanged?()
        case let .approvalEnded(id):
            removeApproval(id)
        case let .paired(name):
            lastPaired = name
            trusted = host.trustedDevices()
            refreshPairing()
        case let .notice(message):
            notice = message
        }
    }

    private func removeApproval(_ id: UInt64) {
        let before = approvals.count
        approvals.removeAll { $0.id == id }
        if approvals.count != before { onApprovalsChanged?() }
    }

    private func preferencesChanged() {
        bridge.setAllowsShell(preferences.allowShell)
        if preferences.port != configuredPort, isRunning || status == .starting || hasFailed {
            restart()
        } else {
            configuredPort = preferences.port
            host.updateConfig(config: makeConfig())
            refreshPairing()
        }
    }

    private func permissionsChanged() {
        host.permissionChanged()
        host.updateConfig(config: makeConfig())
        if permissions.canControl, notice?.contains("Accessibility") == true { notice = nil }
    }

    private func makeConfig() -> HostConfig {
        HostConfig(
            port: UInt16(preferences.port),
            dataDir: SystemInfo.dataDirectory.path,
            webRoot: SystemInfo.webRoot?.path ?? "",
            hostName: SystemInfo.bonjourHostName,
            computerName: SystemInfo.computerName,
            appVersion: SystemInfo.appVersion,
            linkHost: preferences.linkHost,
            allowLocalProxy: preferences.allowLocalProxy,
            allowPin: preferences.allowPin,
            allowApproval: preferences.allowApproval,
            allowShell: preferences.allowShell,
            voiceAvailable: preferences.voiceEnabled && SpeechService.mayBeAvailable
        )
    }

    // MARK: System state

    private func sendSystemState() {
        sendLayout()
        sendInputTiming()
        if let state = bridge.volume.current() {
            host.setVolumeState(value: state.value, muted: state.muted)
        }
    }

    private func sendLayout() {
        guard let layout = KeyboardLayouts.current() else { return }
        layoutName = layout.name
        host.setLayout(layout: layout)
    }

    private func sendInputTiming() {
        let timing = SystemInfo.inputTiming
        host.setInputTiming(repeatDelayMs: timing.repeatDelay, repeatIntervalMs: timing.repeatInterval, doubleClickMs: timing.doubleClick)
    }

    private func schedulePairingRefresh(after seconds: TimeInterval) {
        pairingTimer?.invalidate()
        guard seconds > 0 else { return }
        let timer = Timer(timeInterval: seconds + 0.25, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshPairing() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pairingTimer = timer
    }

    private func observeSystem() {
        observers.append(KeyboardLayouts.observe { [weak self] in self?.sendLayout() })

        let workspace = NSWorkspace.shared.notificationCenter
        let appNotifications: [Notification.Name] = [
            NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
            NSWorkspace.didActivateApplicationNotification, NSWorkspace.didHideApplicationNotification,
            NSWorkspace.didUnhideApplicationNotification,
        ]
        // Connecting or ejecting a drive adds or removes the apps on it.
        let rescanNotifications: Set<Notification.Name> = [
            NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didMountNotification, NSWorkspace.didUnmountNotification,
        ]
        for name in appNotifications + [NSWorkspace.didMountNotification, NSWorkspace.didUnmountNotification] {
            observers.append(workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let rescan = rescanNotifications.contains(note.name)
                MainActor.assumeIsolated { self?.appsDidChange(rescan: rescan) }
            })
        }

        // Host and computer names can change in System Settings → Sharing.
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshNames() }
        })

        // Joining a network can also change the Bonjour name, such as to
        // Studio-2.local when another Mac already uses Studio.local.
        network.pathUpdateHandler = { [weak self] _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.refreshNames() }
            }
        }
        network.start(queue: DispatchQueue(label: "app.cmdpalm.network"))
    }

    private func refreshNames() {
        host.updateConfig(config: makeConfig())
        if isRunning { refreshPairing() }
    }

    private func appsDidChange(rescan: Bool) {
        if rescan { bridge.apps.invalidate() }
        appsChanged?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.host.appsChanged() }
        appsChanged = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }
}
