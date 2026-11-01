import XCTest

/// Real touch gestures on the bundled demo surfaces (offline: no server, nothing is sent):
/// the dimmer ring turns by circular drag, a knob turns by vertical drag, and a hack row takes a tap.
@MainActor
final class ControlGestureTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launchDemo() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-CEOffline", "1", "-CEDemo", "1", "-CETab", "hacks"]
        app.launch()
        return app
    }

    /// The control itself (an adjustable accessibility element), not its caption text with the same label.
    private func element(_ app: XCUIApplication, label: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@ AND elementType != %d", label, XCUIElement.ElementType.staticText.rawValue))
            .firstMatch
    }

    func testRingKnobAndHackGestures() throws {
        let app = launchDemo()

        // dimmer ring (ceiling light): drag a quarter turn clockwise around the ring
        let ring = element(app, label: "BRIGHTNESS")
        XCTAssertTrue(ring.waitForExistence(timeout: 90), "dimmer ring not shown")
        let ringBefore = ring.value as? String
        ring.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
            .press(forDuration: 0.15, thenDragTo: ring.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        let ringAfter = ring.value as? String
        XCTAssertNotEqual(ringBefore, ringAfter, "ring value did not change: \(ringBefore ?? "nil")")
        add(screenshot(app, "ring-after-drag"))

        // hack row: a tap on a demo surface is recorded locally and never sent
        let hack = app.descendants(matching: .any).matching(identifier: "hack.h1").firstMatch
        for _ in 0..<4 where !hack.isHittable { app.swipeUp() }
        XCTAssertTrue(hack.waitForExistence(timeout: 10), "hack row FULL ON not shown")
        hack.tap()
        XCTAssertTrue(app.staticTexts["demo · not sent"].waitForExistence(timeout: 10), "hack tap not registered")
        add(screenshot(app, "hack-tapped"))

        // knob (OP-1 Field): vertical drag up turns it up
        for _ in 0..<4 { app.swipeDown() }
        let chip = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'OP-1'")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "OP-1 device chip not shown")
        chip.tap()
        let knob = element(app, label: "BLUE")
        XCTAssertTrue(knob.waitForExistence(timeout: 10), "BLUE knob not shown")
        let knobBefore = knob.value as? String
        knob.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
            .press(forDuration: 0.15, thenDragTo: knob.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)))
        let knobAfter = knob.value as? String
        XCTAssertNotEqual(knobBefore, knobAfter, "knob value did not change: \(knobBefore ?? "nil")")
        add(screenshot(app, "knob-after-drag"))
        print("GESTURES ring \(ringBefore ?? "?") -> \(ringAfter ?? "?") · knob \(knobBefore ?? "?") -> \(knobAfter ?? "?")")
    }

    private func screenshot(_ app: XCUIApplication, _ name: String) -> XCTAttachment {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        return a
    }
}
