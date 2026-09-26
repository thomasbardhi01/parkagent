import SwiftUI
import UIKit
import XCTest

@testable import ParkAgent

/// iOS 26 cross-dissolves between tabs, which showed Wallet and Activity
/// on top of each other mid-switch. The fix answers the tab controller's
/// transition question with a zero-length swap; this proves it is
/// installed on the controller a real SwiftUI TabView creates.
@MainActor
final class InstantTabSwitchTests: XCTestCase {
    func testTheTabViewSwitchesWithNoTransitionTime() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: TabView {
            Text("A").tabItem { Text("A") }
            Text("B").tabItem { Text("B") }
        }
        .instantTabSwitches())
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        var tabs: UITabBarController?
        for _ in 0..<50 where tabs?.delegate == nil || !(tabs?.delegate is InstantTabTransitionDelegate) {
            RunLoop.main.run(until: .now.addingTimeInterval(0.05))
            tabs = Self.find(in: host)
        }
        let controller = try XCTUnwrap(tabs, "SwiftUI's TabView made no tab controller")
        let delegate = try XCTUnwrap(controller.delegate as? InstantTabTransitionDelegate)
        let from = try XCTUnwrap(controller.viewControllers?.first)
        let to = try XCTUnwrap(controller.viewControllers?.last)
        let transition = try XCTUnwrap(delegate.tabBarController(controller, animationControllerForTransitionFrom: from, to: to))
        XCTAssertEqual(transition.transitionDuration(using: nil), 0)
    }

    private static func find(in controller: UIViewController) -> UITabBarController? {
        if let tabs = controller as? UITabBarController { return tabs }
        return controller.children.lazy.compactMap { find(in: $0) }.first
    }
}
