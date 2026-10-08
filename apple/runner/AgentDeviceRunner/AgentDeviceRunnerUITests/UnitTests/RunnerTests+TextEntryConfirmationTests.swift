import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  private static let otpFieldIdentity = TextEntryElementIdentity(
    identifier: "otp-input",
    elementType: "TextField",
    frame: CGRect(x: 40, y: 200, width: 290, height: 52)
  )

  private static func otpObservation(
    _ value: String,
    identity: TextEntryElementIdentity = otpFieldIdentity
  ) -> TextEntryObservation {
    TextEntryObservation(value: value, identity: identity)
  }

  func testDegradedEchoesStayEchoesAndSummariesDoNot() {
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "", expected: "123456", baseline: ""))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "12456", expected: "123456", baseline: ""))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "old123456", expected: "123456", baseline: ""))
    // #2634: a complete mask value lost nothing, so it is not a degraded copy and not an echo.
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "(555) 123-4567", expected: "5551234567", baseline: ""))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "hello", expected: "hello\n", baseline: ""))
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "6 of 6 digits", expected: "123456", baseline: ""))
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "6 digits", expected: "123456", baseline: ""))
  }

  // The completion predicate's own table: positives are real formatter outputs for their
  // request; the negatives are the degradations and residual shapes the echo must keep.
  // Pairing them is the whole duty of this predicate — completion never claims correctness
  // (only exact equality verifies), it only decides who may reach the unconfirmed outcome.
  func testOnlyInteriorForeignInsertionsCompleteARequest() {
    XCTAssertTrue(Self.textValueCompletesRequest(observed: "00 062 91 77", request: "000629177", baseline: ""))
    XCTAssertTrue(Self.textValueCompletesRequest(observed: "(555) 123-4567", request: "5551234567", baseline: ""))
    XCTAssertTrue(Self.textValueCompletesRequest(observed: "$10.00", request: "1000", baseline: ""))
    // Dropped digit inside the grouping: the value no longer contains the request at all.
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "00 62 91 7", request: "000629177", baseline: ""))
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "00 062 91 7", request: "000629177", baseline: ""))
    // Reordering is a drop plus a re-insertion: the request is not in order inside it.
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "00 026 91 77", request: "000629177", baseline: ""))
    // End-only insertions are where residual text from a failed clear lands.
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "old123456", request: "123456", baseline: ""))
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "123456old", request: "123456", baseline: ""))
    // A doubled entry leaves its surplus at the ends under the leftmost embedding.
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "66", request: "6", baseline: ""))
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "121", request: "12", baseline: ""))
    // A one-character request has no between; a mask separator that appears IN the request makes
    // the embedding ambiguous, so the echo reading stands.
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "$0.05", request: "5", baseline: ""))
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "1.234.5", request: "12.5", baseline: ""))
    XCTAssertFalse(Self.textValueCompletesRequest(observed: "anything", request: "", baseline: ""))
  }

  func testDigitCountSummaryThatMovedOffItsBaselineIsUnconfirmed() {
    let evidence = Self.unconfirmedTextEntryEvidence(
      requested: "123456",
      baseline: Self.otpObservation("0 of 6 digits"),
      observed: Self.otpObservation("6 of 6 digits")
    )

    XCTAssertEqual(
      evidence,
      TextEntryUnconfirmedEvidence(
        requested: "123456",
        before: "0 of 6 digits",
        after: "6 of 6 digits",
        target: Self.otpFieldIdentity
      )
    )
  }

  func testSingleCharacterTheSummaryAlreadyContainedIsUnconfirmed() {
    let evidence = Self.unconfirmedTextEntryEvidence(
      requested: "6",
      baseline: Self.otpObservation("0 of 6 digits"),
      observed: Self.otpObservation("1 of 6 digits")
    )

    XCTAssertEqual(evidence?.after, "1 of 6 digits")
  }

  func testRequestTheBaselineContainedEchoesOnlyWithTheBaseline() {
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "66", expected: "6", baseline: "6"))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "0 of 6 digits6", expected: "6", baseline: "0 of 6 digits"))
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "1 of 6 digits", expected: "6", baseline: "0 of 6 digits"))
    XCTAssertFalse(Self.textEntryValueEchoes(observed: "6 of 6 digits", expected: "123456", baseline: "0 of 6 digits"))
    XCTAssertTrue(Self.textEntryValueEchoes(observed: "abc123abc12", expected: "abc123", baseline: "abc123"))
  }

  func testEveryOtherReplacementMismatchStaysAFailure() {
    let baseline = Self.otpObservation("0 of 6 digits")
    let otherField = TextEntryElementIdentity(
      identifier: "name-input",
      elementType: "TextField",
      frame: Self.otpFieldIdentity.frame
    )
    let cases: [(String, String, TextEntryObservation?, TextEntryObservation?)] = [
      ("value never moved", "123456", baseline, Self.otpObservation("0 of 6 digits")),
      ("dropped characters echo the request", "123456", baseline, Self.otpObservation("12456")),
      (
        "dropped characters echo a stale baseline plus the request", "abc123",
        Self.otpObservation("abc123"), Self.otpObservation("abc123abc12")
      ),
      ("another element took the entry", "123456", baseline, Self.otpObservation("6 of 6 digits", identity: otherField)),
      ("unreadable before the entry", "123456", nil, Self.otpObservation("6 of 6 digits")),
      ("unreadable after the entry", "123456", baseline, nil),
      ("nothing formats the empty value", "", baseline, Self.otpObservation("6 of 6 digits")),
      ("a bare submit key types no text", "\n", baseline, Self.otpObservation("6 of 6 digits")),
    ]
    for (name, requested, before, after) in cases {
      XCTAssertNil(
        Self.unconfirmedTextEntryEvidence(requested: requested, baseline: before, observed: after),
        name
      )
    }
  }

  // #2634: a completing value reaches the unconfirmed path with before/after evidence and is
  // never verified (a cents-shifting mask like "$10.00" for "1000" passes completion); shapes
  // whose entry may have failed stay failures, "adxe" under #2903's ownership.
  func testACompletingFieldReachesUnconfirmedAndDegradationsStayFailures() {
    let grouping = Self.unconfirmedTextEntryEvidence(
      requested: "000629177",
      baseline: Self.otpObservation(""),
      observed: Self.otpObservation("00 062 91 77")
    )
    XCTAssertEqual(grouping?.requested, "000629177")
    XCTAssertEqual(grouping?.before, "")
    XCTAssertEqual(grouping?.after, "00 062 91 77")

    let phone = Self.unconfirmedTextEntryEvidence(
      requested: "5551234567",
      baseline: Self.otpObservation(""),
      observed: Self.otpObservation("(555) 123-4567")
    )
    XCTAssertEqual(phone?.after, "(555) 123-4567")

    // The cents-shift pair: disclosed, never verified.
    let currency = Self.unconfirmedTextEntryEvidence(
      requested: "1000",
      baseline: Self.otpObservation(""),
      observed: Self.otpObservation("$10.00")
    )
    XCTAssertEqual(currency?.after, "$10.00")
    // A value that lost its decimal under a thousands-separator mask matches no echo clause and
    // was unconfirmed before this change; pin that it stays so.
    let lostSeparator = Self.unconfirmedTextEntryEvidence(
      requested: "10.50",
      baseline: Self.otpObservation(""),
      observed: Self.otpObservation("1,050")
    )
    XCTAssertEqual(lostSeparator?.after, "1,050")
    // A digit lost under the grouping itself: unconfirmed today, and still unconfirmed.
    let lostDigit = Self.unconfirmedTextEntryEvidence(
      requested: "000629177",
      baseline: Self.otpObservation(""),
      observed: Self.otpObservation("00 062 91 7")
    )
    XCTAssertEqual(lostDigit?.after, "00 062 91 7")

    // Residual text from a partial clear may not sit inside the completed span: with baseline
    // "12" still in the field, "12 567 8" holds "125678", not "5678". The grouping spaces are
    // real insertions, so completion must die once a baseline character turns out to explain
    // part of the value; on main this shape was a containment echo and got its repair.
    XCTAssertNil(
      Self.unconfirmedTextEntryEvidence(
        requested: "5678",
        baseline: Self.otpObservation("12"),
        observed: Self.otpObservation("12 567 8")
      )
    )

    // The refusals, each the completion positives' closest negative. Note the shape they share:
    // every one of them is still an echo — a value that could be a degraded copy — which is the
    // only refusal this path now makes. Values that match no echo clause at all (a digit lost
    // under the grouping, "00 062 91 7") were unconfirmed before this change and still are:
    // completion only ever ADDS to the echo set's exceptions, never removes one.
    for (name, requested, observed) in [
      ("dropped characters", "123456", "12456"),
      ("stale residual text", "123456", "old123456"),
      ("write-back truncation (#2903)", "ada@example", "adxe"),
      ("doubled entry", "6", "66"),
    ] {
      XCTAssertNil(
        Self.unconfirmedTextEntryEvidence(
          requested: requested,
          baseline: Self.otpObservation(""),
          observed: Self.otpObservation(observed)
        ),
        name
      )
    }
    // The completion predicate's closest negative, at the wire decision: a grouping-shaped value
    // whose digits are OUT of request order. Completion refuses it (table above), and it matched
    // no echo clause on `main` either — a reorder is not a degraded copy of baseline + request —
    // so disclosure was and stays its reading, never repair and never verified.
    let reordered = Self.unconfirmedTextEntryEvidence(
      requested: "000629177",
      baseline: Self.otpObservation(""),
      observed: Self.otpObservation("00 026 91 77")
    )
    XCTAssertEqual(reordered?.after, "00 026 91 77")

    // A value that never moved off its baseline is still no evidence, however well it completes.
    XCTAssertNil(
      Self.unconfirmedTextEntryEvidence(
        requested: "5551234567",
        baseline: Self.otpObservation("(555) 123-4567"),
        observed: Self.otpObservation("(555) 123-4567")
      )
    )
  }

  func testElementWithoutIdentifierIsTheSameOnlyAtTheSameTypeAndFrame() {
    let frame = CGRect(x: 0, y: 0, width: 100, height: 40)
    let field = TextEntryElementIdentity(identifier: nil, elementType: "TextField", frame: frame)

    XCTAssertTrue(field.isSameElement(as: TextEntryElementIdentity(identifier: nil, elementType: "TextField", frame: frame)))
    XCTAssertFalse(field.isSameElement(as: TextEntryElementIdentity(identifier: nil, elementType: "TextView", frame: frame)))
    XCTAssertFalse(field.isSameElement(as: TextEntryElementIdentity(identifier: nil, elementType: "TextField", frame: frame.offsetBy(dx: 0, dy: 60))))
    XCTAssertFalse(field.isSameElement(as: TextEntryElementIdentity(identifier: "otp-input", elementType: "TextField", frame: frame)))
  }

  func testVerificationTargetEncodesMissingIdentityAsExplicitNulls() throws {
    let payload = TextEntryVerificationTargetPayload(
      resourceId: nil,
      className: "TextField",
      packageName: nil,
      rect: SnapshotRect(x: 1, y: 2, width: 3, height: 4)
    )
    let json = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
    )

    XCTAssertTrue(json["resourceId"] is NSNull)
    XCTAssertTrue(json["packageName"] is NSNull)
    XCTAssertEqual(json["className"] as? String, "TextField")
    XCTAssertEqual(json["rect"] as? [String: Double], ["x": 1, "y": 2, "width": 3, "height": 4])
  }

#if os(iOS)
  /// An OTP field that announces "6 of 6 digits" instead of the digits it holds. Every digit
  /// arrives, so the fill succeeds with evidence instead of failing on a summary it compared
  /// against the code, and the code is typed once rather than retyped by a repair.
  @MainActor
  func testFillIntoDigitCountFieldReportsUnconfirmedEvidence() throws {
    try assertDigitCountFillIsUnconfirmed(code: "123456", summary: "6 of 6 digits")
  }

  /// A single digit the "0 of 6 digits" baseline already contains is not an echo of the summary,
  /// so it is typed once instead of retyped into "66".
  @MainActor
  func testSingleDigitFillIntoDigitCountFieldIsTypedOnce() throws {
    try assertDigitCountFillIsUnconfirmed(code: "6", summary: "1 of 6 digits")
  }

  /// #2634: a field that reformats what it holds, the way a `## ### ## ##` digit-grouping formatter
  /// does. Every requested digit arrives, so the fill succeeds with target-bound evidence instead of
  /// failing on a value raw equality can never reach — and, the reported half, the runner does not
  /// clear and retype the field it was asked to fill: the unconfirmed check runs before any repair,
  /// and the response message proves it ("typed after repair" would name the retype).
  @MainActor
  func testFillIntoDigitGroupingFieldReportsUnconfirmedEvidenceAndDoesNotRepair() throws {
    let textField = try assertFillIntoNormalizingFieldIsUnconfirmed(
      fixtureFlag: "--agent-device-text-entry-digit-grouping-value",
      commandId: "fill-digit-grouping",
      text: "000629177",
      expectedBefore: "",
      expectedAfter: "00 062 91 77"
    )
    // The field is left holding the digits the request carried, grouped: neither cleared out nor
    // doubled by a retype.
    let deadline = Date().addingTimeInterval(appExistenceTimeout)
    var observed: String?
    while Date() < deadline {
      observed = textField.value as? String
      if observed == "00 062 91 77" { break }
      Thread.sleep(forTimeInterval: 0.25)
    }
    XCTAssertEqual(observed, "00 062 91 77")
  }

  /// Fills the digit-count fixture field with `code` and asserts unconfirmed evidence and one entry.
  @MainActor
  private func assertDigitCountFillIsUnconfirmed(code: String, summary: String) throws {
    try assertFillIntoNormalizingFieldIsUnconfirmed(
      fixtureFlag: "--agent-device-text-entry-digit-count-value",
      commandId: "fill-digit-count",
      text: code,
      expectedBefore: "0 of 6 digits",
      expectedAfter: summary
    )
    // The slots an OTP screen renders next to its input carry the digits the field really holds.
    XCTAssertEqual(app.staticTexts["agent-device-text-entry-digit-slots"].label, code)
  }

  /// Launches the `--agent-device-text-entry-regression` field chosen by `fixtureFlag`, fills
  /// `text` through the daemon's `type`/replace command addressed at the field's center, and
  /// asserts the fill succeeded once with target-bound unconfirmed evidence carrying
  /// `expectedBefore`/`expectedAfter`. The field is returned for the caller's own after-entry
  /// oracle, which is the only thing that differs between the normalizing fixtures: a digit-count
  /// field's own value is a summary, a grouping field's is the formatted text.
  @MainActor
  @discardableResult
  private func assertFillIntoNormalizingFieldIsUnconfirmed(
    fixtureFlag: String,
    commandId: String,
    text: String,
    expectedBefore: String,
    expectedAfter: String
  ) throws -> XCUIElement {
    app.launchArguments = ["--agent-device-text-entry-regression", fixtureFlag]
    app.launch()
    addTeardownBlock { [self] in
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let textField = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(textField.waitForExistence(timeout: appExistenceTimeout))
    let frame = textField.frame
    let command = try JSONDecoder().decode(
      Command.self,
      from: JSONSerialization.data(withJSONObject: [
        "command": "type",
        "commandId": commandId,
        "text": text,
        "textEntryMode": "replace",
        "x": frame.midX,
        "y": frame.midY,
        "appBundleId": "com.callstack.agentdevice.runner",
      ])
    )

    let failuresBeforeType = currentXCTestFailureCount()
    let response = executeTypeCommand(activeApp: app, command: command)

    XCTAssertFalse(didRecordXCTestFailure(since: failuresBeforeType))
    XCTAssertTrue(response.ok, String(describing: response.error))
    // "typed", never "typed after repair": the unconfirmed check runs before any repair, so a
    // normalizing field is entered exactly once.
    XCTAssertEqual(response.data?.message, "typed")
    XCTAssertEqual(response.data?.verification, "unconfirmed")
    XCTAssertEqual(response.data?.requested, text)
    XCTAssertEqual(response.data?.before, expectedBefore)
    XCTAssertEqual(response.data?.after, expectedAfter)
    XCTAssertEqual(response.data?.target?.resourceId, "agent-device-hardware-keyboard-input")
    XCTAssertEqual(response.data?.target?.className, "TextField")
    XCTAssertEqual(response.data?.target?.packageName, "com.callstack.agentdevice.runner")
    return textField
  }
#endif
#endif
}
