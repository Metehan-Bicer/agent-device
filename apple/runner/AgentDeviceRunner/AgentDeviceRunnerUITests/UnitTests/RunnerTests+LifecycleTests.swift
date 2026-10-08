import Foundation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
/// One row of the cross-language golden table. Its `query` column names the shared fact — this alert
/// request changes nothing — which each side maps to its own consumer: replay eligibility here, and
/// the TypeScript `readOnly` trait there.
private struct AlertCommandTraitsFixture: Decodable {
  let name: String
  let command: Command
  let query: Bool
}

extension RunnerTests {
  func testAlertRetryFactMatchesTheSharedGoldenTable() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("contracts/fixtures/alert-command-traits.json")
    let cases = try JSONDecoder().decode(
      [AlertCommandTraitsFixture].self,
      from: Data(contentsOf: fixtureURL)
    )
    XCTAssertEqual(cases.map { $0.command.action }, [nil, "get", "accept", "dismiss"])
    for fixture in cases {
      XCTAssertEqual(
        fixture.command.traits.retryOnSessionLoss,
        fixture.query,
        fixture.name
      )
    }
  }

  func testTargetAppUnavailableResponseIsRetried() {
    for bundleId in ["com.example.app", nil] as [String?] {
      let response = Response(ok: false, error: .targetAppUnavailable(bundleId: bundleId))
      XCTAssertTrue(shouldRetryResponse(response), String(describing: bundleId))
    }
    let reworded = ErrorPayload(message: "target vanished", retryableFailure: .targetAppUnavailable)
    XCTAssertTrue(shouldRetryResponse(Response(ok: false, error: reworded)))
  }

  func testUntypedUnavailableMessageIsNotRetried() {
    for message in ["app 'com.example.app' is not available", "runner app is not available"] {
      let response = Response(ok: false, error: ErrorPayload(message: message))
      XCTAssertFalse(shouldRetryResponse(response), message)
    }
    let succeeded = Response(ok: true, error: .targetAppUnavailable(bundleId: nil))
    XCTAssertFalse(shouldRetryResponse(succeeded))
  }

  func testExceptionRetryIsLimitedToTheAxServerNotFoundReadOnlyCase() throws {
    let readText = try runnerCommandFixture(#"{"command":"readText"}"#)
    let snapshot = try runnerCommandFixture(#"{"command":"snapshot"}"#)
    let tap = try runnerCommandFixture(#"{"command":"tap"}"#)
    let axServerNotFound = "NSException: Error kAXErrorServerNotFound"
    XCTAssertTrue(shouldRetryException(readText, message: axServerNotFound))
    XCTAssertFalse(shouldRetryException(tap, message: axServerNotFound))
    XCTAssertFalse(
      shouldRetryException(readText, message: "NSException: main thread execution timed out")
    )
    XCTAssertFalse(shouldRetryException(snapshot, message: "NSException: query timed out"))
  }

  func testInlineScreenshotResponseKeepsDisplayFactsBesideTheImage() throws {
    let pngData = Data([0x89, 0x50, 0x4E, 0x47])
    let response = screenshotResponse(
      pngData: pngData,
      inlineScreenshot: true,
      metadata: ScreenshotMetadataPayload(
        displayID: 3,
        pixelWidth: 2852,
        pixelHeight: 2006,
        pixelsPerPoint: 3
      )
    )
    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.imageBase64, pngData.base64EncodedString())
    XCTAssertEqual(response.data?.screenshotMetadata?.displayID, 3)
    XCTAssertNil(response.data?.message, "an inline answer must not also name a file")
  }

  func testFileScreenshotResponseWritesTheImageAndStillReportsItsDisplay() throws {
    let pngData = Data([0x89, 0x50, 0x4E, 0x47])
    let response = screenshotResponse(
      pngData: pngData,
      inlineScreenshot: false,
      metadata: ScreenshotMetadataPayload(
        displayID: 1,
        pixelWidth: 1398,
        pixelHeight: 2034,
        pixelsPerPoint: 3
      )
    )
    XCTAssertTrue(response.ok)
    XCTAssertNil(response.data?.imageBase64, "a file answer must not also carry bytes")
    let message = try XCTUnwrap(response.data?.message)
    // The answer names the file rather than carrying bytes, and the name is a host-resolvable form:
    // absolute on macOS, container-relative `tmp/…` on iOS. Both name the one file just written
    // into the runner's temporary directory.
    let fileName = URL(fileURLWithPath: message).lastPathComponent
    XCTAssertTrue(message.hasSuffix(fileName), message)
#if os(iOS)
    XCTAssertTrue(message.hasPrefix("tmp/"), message)
#elseif os(macOS)
    XCTAssertTrue(message.hasPrefix("/"), message)
#endif
    let storedPath = (NSTemporaryDirectory() as NSString).appendingPathComponent(fileName)
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: storedPath)), pngData)
    XCTAssertEqual(response.data?.screenshotMetadata?.pixelsPerPoint, 3)
    try? FileManager.default.removeItem(atPath: storedPath)
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(macOS)
extension RunnerTests {
  /// Pins every state the macOS screenshot raise condition reads (#3254): only an app that is not
  /// already foreground is ever raised, and only a window-level grab needs it — a `--fullscreen`
  /// capture of a running app answers from any foreground. A stopped app keeps its standing answer in
  /// both shapes, because there the activation is also the launch it has always performed; the
  /// change is that full-screen stops paying a raise for a RUNNING app its pixels never needed. The
  /// screenshot call site reads this same function, so a drifted condition is a red row rather than a
  /// silent behavior change.
  func testMacAppCaptureNeedsRaiseIsWindowLevelAndBackgroundOnly() {
    let foreground = XCUIApplication.State.runningForeground
    let background = XCUIApplication.State.runningBackground
    let notRunning = XCUIApplication.State.notRunning
    // Rows are literal expectations, not the condition recomputed: a drifted condition must land as
    // a red row here, not move both sides of the comparison together.
    let table: [(fullscreen: Bool?, state: XCUIApplication.State, expected: Bool)] = [
      (nil, foreground, false),
      (nil, background, true),
      (nil, notRunning, true),
      (false, foreground, false),
      (false, background, true),
      (false, notRunning, true),
      (true, foreground, false),
      (true, background, false),
      (true, notRunning, true),
    ]
    for row in table {
      XCTAssertEqual(
        macAppCaptureNeedsRaise(fullscreen: row.fullscreen, targetState: row.state),
        row.expected,
        "fullscreen=\(String(describing: row.fullscreen)) state=\(row.state.rawValue)"
      )
    }
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  @MainActor
  func testResettingTargetBoundStateForgetsTheLastWrittenMarkers() {
    defer { invalidateCachedTarget(reason: "unit_test_cleanup") }
    lastLoggedFastAppGuardLine = "AGENT_DEVICE_RUNNER_FAST_APP_GUARD bundle=app state=4"
    lastLoggedGesturePolicyLines[.scroll] = "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=scroll"
    resetTargetBoundState()
    XCTAssertNil(lastLoggedFastAppGuardLine, "a rebind must state the guard once more")
    XCTAssertTrue(lastLoggedGesturePolicyLines.isEmpty, "a rebind must state the policy once more")
  }

  @MainActor
  func testFastAppGuardMarkerWritesOnceUntilTheFactChanges() {
    var written: [String] = []
    runnerMarkerWriter = { written.append($0) }
    defer {
      runnerMarkerWriter = { NSLog("%@", $0) }
      invalidateCachedTarget(reason: "unit_test_cleanup")
    }
    writeFastAppGuardMarker(bundleId: "com.example.app", state: .runningForeground)
    writeFastAppGuardMarker(bundleId: "com.example.app", state: .runningForeground)
    XCTAssertEqual(written.count, 1, "a repeated fact writes no second line")
    writeFastAppGuardMarker(bundleId: "com.example.other", state: .runningForeground)
    XCTAssertEqual(written.count, 2, "a changed fact writes a new line")
    resetTargetBoundState()
    writeFastAppGuardMarker(bundleId: "com.example.other", state: .runningForeground)
    XCTAssertEqual(written.count, 3, "a rebind states the same fact once more")
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  /// Installed on every Simulator runtime and cheap to leave terminated.
  private static let notRunningTargetBundleId = "com.apple.Preferences"

  @MainActor
  private func executeOnTerminatedTarget(_ json: String) throws -> (Response, XCUIApplication) {
    let target = XCUIApplication(bundleIdentifier: Self.notRunningTargetBundleId)
    target.terminate()
    invalidateCachedTarget(reason: "unit_test_setup")
    defer { invalidateCachedTarget(reason: "unit_test_cleanup") }
    return (try execute(command: try runnerCommandFixture(json)), target)
  }

  /// Covers a user-level read, a mutation's leading read (a gesture's `gestureViewport`), and the read
  /// that resolves a selector tap (`querySelector`, whose refusal the retry fact alone used to decide,
  /// #2890).
  @MainActor
  func testReadRefusesToLaunchANotRunningSessionApp() throws {
    let bundleId = Self.notRunningTargetBundleId
    for request in [
      #"{"command":"snapshot","commandId":"read","appBundleId":"\#(bundleId)"}"#,
      #"{"command":"gestureViewport","commandId":"read","appBundleId":"\#(bundleId)"}"#,
      #"{"command":"querySelector","selectorKey":"label","selectorValue":"Settings","commandId":"read","appBundleId":"\#(bundleId)"}"#
    ] {
      let (response, target) = try executeOnTerminatedTarget(request)
      XCTAssertEqual(response.error?.code, RunnerWireErrorCode.appNotRunning, request)
      XCTAssertEqual(target.state, .notRunning, "\(request) must not launch the session app")
      target.terminate()
    }
  }

  @MainActor
  func testNonReadCommandStillLaunchesANotRunningSessionApp() throws {
    let (response, target) = try executeOnTerminatedTarget(
      #"{"command":"activate","commandId":"repair","appBundleId":"\#(Self.notRunningTargetBundleId)"}"#
    )
    defer { target.terminate() }
    XCTAssertTrue(response.ok)
    XCTAssertNotEqual(target.state, .notRunning)
  }
}
#endif
