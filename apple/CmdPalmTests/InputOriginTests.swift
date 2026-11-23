import AppKit
import Testing
@testable import CmdPalm

@Suite struct InputOriginTests {
    private func event(userData: Int64 = 0, pid: Int64 = 0) throws -> CGEvent {
        let source = try #require(CGEventSource(stateID: .hidSystemState))
        source.userData = userData
        let event = try #require(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: .zero, mouseButton: .left))
        event.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
        return event
    }

    @Test func markerMatchesTheCore() {
        #expect(inputEventMarker() == 0x434D4450)
    }

    @Test func eventsWithTheMarkerAreFromCmdPalm() throws {
        #expect(InputOrigin.isFromCmdPalm(try event(userData: InputOrigin.marker)))
    }

    @Test func eventsFromThisProcessAreFromCmdPalm() throws {
        #expect(InputOrigin.isFromCmdPalm(try event(pid: Int64(getpid()))))
    }

    @Test func otherEventsAreNot() throws {
        #expect(!InputOrigin.isFromCmdPalm(try event()))
        #expect(!InputOrigin.isFromCmdPalm(nil))
    }

    @MainActor @Test func devicesMayApproveOnlyWhenAllowed() throws {
        let original = InputOrigin.current
        defer { InputOrigin.current = original }
        let marked = try #require(NSEvent(cgEvent: try event(userData: InputOrigin.marker)))
        InputOrigin.current = { marked }
        #expect(!InputOrigin.mayGrant(devicesMayApprove: false))
        #expect(InputOrigin.mayGrant(devicesMayApprove: true))
        let plain = try #require(NSEvent(cgEvent: try event()))
        InputOrigin.current = { plain }
        #expect(InputOrigin.mayGrant(devicesMayApprove: false))
        #expect(InputOrigin.mayGrant(devicesMayApprove: true))
    }

    @MainActor @Test func currentEventIsChecked() throws {
        let original = InputOrigin.current
        defer { InputOrigin.current = original }
        let marked = try #require(NSEvent(cgEvent: try event(userData: InputOrigin.marker)))
        InputOrigin.current = { marked }
        #expect(InputOrigin.currentIsFromCmdPalm)
        let plain = try #require(NSEvent(cgEvent: try event()))
        InputOrigin.current = { plain }
        #expect(!InputOrigin.currentIsFromCmdPalm)
        InputOrigin.current = { nil }
        #expect(!InputOrigin.currentIsFromCmdPalm)
    }
}
