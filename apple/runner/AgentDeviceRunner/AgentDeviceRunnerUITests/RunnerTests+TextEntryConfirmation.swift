import XCTest

// What a replacement's read-back can prove when the field's value does not echo the typed text.
// The wire shape mirrors the cross-platform `FillUnconfirmedVerification` in
// packages/contracts/src/fill-evidence.ts.
extension RunnerTests {
  /// The element a replacement typed into, named the way the shared fill evidence names a target.
  struct TextEntryElementIdentity: Equatable {
    let identifier: String?
    let elementType: String
    let frame: CGRect

    /// Same element across the entry: a stable accessibility identifier when either side has one,
    /// otherwise the same element type at the same frame.
    func isSameElement(as other: TextEntryElementIdentity) -> Bool {
      if identifier != nil || other.identifier != nil {
        return identifier == other.identifier
      }
      return elementType == other.elementType && frame == other.frame
    }
  }

  /// A field's readable value and identity, sampled once.
  struct TextEntryObservation: Equatable {
    let value: String
    let identity: TextEntryElementIdentity

    /// Same value on the same element; a frame change alone on an identified field is not a change.
    func isSettled(with other: TextEntryObservation) -> Bool {
      value == other.value && identity.isSameElement(as: other.identity)
    }
  }

  /// Target-bound evidence that the entry changed the field while its value cannot confirm the text.
  struct TextEntryUnconfirmedEvidence: Equatable {
    let requested: String
    let before: String
    let after: String
    let target: TextEntryElementIdentity
  }

  /// Whether `observed` can be a degraded copy of the residual `baseline` plus the request: it is in
  /// order inside baseline + request (dropped characters), or it contains the request in order and
  /// the baseline did not already (residual text), or it contains baseline + request in order. A
  /// value related to the entry in none of these ways, such as an OTP field announcing
  /// "6 of 6 digits", is the app's own representation, so retyping cannot make it match.
  ///
  /// The two containment clauses keep one exception (#2634): a value the request plus inserted
  /// formatting alone EXPLAINS — see `textValueCompletesRequest`, which owns the whole test
  /// including the baseline — is not a degraded copy of anything, and the field that normalizes
  /// its content shows exactly that after receiving the request. Completion is not correctness
  /// (a cents-shifting mask passes it); it only stops the value from being refused the
  /// unconfirmed outcome, and nothing but exact equality verifies.
  static func textEntryValueEchoes(observed: String, expected: String, baseline: String) -> Bool {
    let request = textEntryRequestWithoutSubmitKeys(expected)
    let residualAndRequest = baseline + request
    if isOrderedSubsequence(observed, of: residualAndRequest) {
      return true
    }
    if textValueCompletesRequest(observed: observed, request: request, baseline: baseline) {
      return false
    }
    return (isOrderedSubsequence(request, of: observed) && !isOrderedSubsequence(request, of: baseline))
      || isOrderedSubsequence(residualAndRequest, of: observed)
  }

  /// Whether the request plus inserted formatting explains the WHOLE of `observed`: every request
  /// character in order, every remaining character outside it explainable only as an insertion —
  /// not a character of the request (an ambiguous embedding may be a dropped-and-shifted copy)
  /// and not a character of the post-clear `baseline` either, since a partial clear's residual
  /// text may sit anywhere a mask relocates it — and at least one insertion strictly BETWEEN the
  /// request's first and last characters, because entry cannot insert between two characters the
  /// same burst typed while a failed clear's residual may only be appended or prepended
  /// (`"old123456"` stays an echo). The embedding is the leftmost one, so a doubled entry (`"66"`
  /// for `"6"`) leaves its surplus at the ends; a mask inserting a request character (`.` for a
  /// decimal value) falls back to the echo reading; a one-character request has no between.
  static func textValueCompletesRequest(observed: String, request: String, baseline: String) -> Bool {
    guard !request.isEmpty, request != observed, request.count > 1 else {
      return false
    }
    // The leftmost embedding of the request into the observed value.
    var consumedOffsets = IndexSet()
    var cursor = observed.startIndex
    for character in request {
      guard let match = observed[cursor...].firstIndex(of: character) else {
        return false
      }
      consumedOffsets.insert(observed.distance(from: observed.startIndex, to: match))
      cursor = observed.index(after: match)
    }
    // A one-character request has no between for an insertion to sit in.
    let first = consumedOffsets.first!
    let last = consumedOffsets.last!
    var sawInteriorInsertion = false
    for (offset, character) in observed.enumerated() where !consumedOffsets.contains(offset) {
      // A request character makes the embedding ambiguous; a baseline character may be residual
      // a mask relocated into the span. Either way the request plus formatting does not explain
      // the value.
      if request.contains(character) || baseline.contains(character) {
        return false
      }
      if offset > first && offset < last {
        sawInteriorInsertion = true
      }
    }
    return sawInteriorInsertion
  }

  /// Classifies a replacement whose read-back never matched. The entry is unconfirmed, not failed,
  /// only when the same element's value moved off its pre-entry baseline to one that does not echo
  /// the request; every other mismatch stays a failure.
  static func unconfirmedTextEntryEvidence(
    requested: String,
    baseline: TextEntryObservation?,
    observed: TextEntryObservation?
  ) -> TextEntryUnconfirmedEvidence? {
    guard !textEntryRequestWithoutSubmitKeys(requested).isEmpty,
          let baseline,
          let observed,
          baseline.identity.isSameElement(as: observed.identity),
          observed.value != baseline.value,
          !textEntryValueEchoes(observed: observed.value, expected: requested, baseline: baseline.value)
    else {
      return nil
    }
    return TextEntryUnconfirmedEvidence(
      requested: requested,
      before: baseline.value,
      after: observed.value,
      target: observed.identity
    )
  }

  /// Samples the element's readable value with its identity in one accessibility query; nil when
  /// the element is gone or its value is unreadable (secure fields).
  func textEntryObservation(for element: XCUIElement?) -> TextEntryObservation? {
    guard let element,
          let snapshot = try? element.snapshot(),
          let value = editableTextValue(for: snapshot, treatingPlaceholderAsEmpty: true)
    else {
      return nil
    }
    return TextEntryObservation(
      value: value,
      identity: TextEntryElementIdentity(
        identifier: snapshot.identifier.isEmpty ? nil : snapshot.identifier,
        elementType: elementTypeName(snapshot.elementType),
        frame: snapshot.frame
      )
    )
  }

  /// The text a request leaves in the field once trailing submit keys are pressed rather than typed.
  static func textEntryRequestWithoutSubmitKeys(_ text: String) -> String {
    var request = text
    while request.hasSuffix("\n") || request.hasSuffix("\r") {
      request.removeLast()
    }
    return request
  }

  /// Whether every character of `candidate` appears in `text` in the same order.
  static func isOrderedSubsequence(_ candidate: String, of text: String) -> Bool {
    var remaining = text[...]
    for character in candidate {
      guard let match = remaining.firstIndex(of: character) else {
        return false
      }
      remaining = remaining[remaining.index(after: match)...]
    }
    return true
  }
}
