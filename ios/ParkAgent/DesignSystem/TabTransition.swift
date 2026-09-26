import ObjectiveC
import SwiftUI
import UIKit

/// Tab switches with no cross-dissolve.
///
/// On iOS 26 the system tab controller behind SwiftUI's `TabView` fades
/// the outgoing tab out while the incoming one fades in, over about 100 ms.
/// Two opaque screens at half opacity each are a double exposure (Wallet's
/// rows over Activity's). Opaque tab backgrounds (`tabScreen()`) can't help
/// with that, because the fade applies to the whole screen. The only fix is
/// to not fade, so this installs an instant transition on the tab
/// controller. Every other delegate call still goes to SwiftUI's own
/// delegate, so selection and the binding behave as before.
extension View {
    func instantTabSwitches() -> some View {
        background(InstantTabSwitchInstaller().frame(width: 0, height: 0))
    }
}

private struct InstantTabSwitchInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> InstallerView { InstallerView() }
    func updateUIView(_ view: InstallerView, context: Context) { view.install() }

    final class InstallerView: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            install()
            // The tab controller can join the window a beat after this view.
            DispatchQueue.main.async { [weak self] in self?.install() }
        }

        /// Idempotent: SwiftUI may hand the controller a new delegate on a
        /// later update, so this re-wraps whatever is there each time.
        func install() {
            guard let controller = tabBarController() else { return }
            if controller.delegate is InstantTabTransitionDelegate { return }
            let proxy = InstantTabTransitionDelegate(wrapping: controller.delegate)
            // The delegate property is weak; the controller keeps the proxy.
            objc_setAssociatedObject(controller, &InstantTabTransitionDelegate.key, proxy, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            controller.delegate = proxy
        }

        /// This view sits beside the TabView, not inside it, so the tab
        /// controller is found by searching down from the window's root
        /// instead of up the responder chain.
        private func tabBarController() -> UITabBarController? {
            guard let root = window?.rootViewController else { return nil }
            return Self.find(in: root)
        }

        private static func find(in controller: UIViewController) -> UITabBarController? {
            if let tabs = controller as? UITabBarController { return tabs }
            for child in controller.children {
                if let found = find(in: child) { return found }
            }
            return nil
        }
    }
}

/// Answers the transition question itself and forwards everything else to
/// the delegate it replaced.
final class InstantTabTransitionDelegate: NSObject, UITabBarControllerDelegate {
    nonisolated(unsafe) static var key: UInt8 = 0
    private weak var wrapped: (any UITabBarControllerDelegate)?

    init(wrapping wrapped: (any UITabBarControllerDelegate)?) {
        self.wrapped = wrapped
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (wrapped?.responds(to: selector) ?? false)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if let wrapped, wrapped.responds(to: selector) { return wrapped }
        return super.forwardingTarget(for: selector)
    }

    func tabBarController(
        _ tabBarController: UITabBarController,
        animationControllerForTransitionFrom fromVC: UIViewController,
        to toVC: UIViewController
    ) -> (any UIViewControllerAnimatedTransitioning)? {
        InstantTabTransition()
    }
}

/// Swaps the incoming tab in with no animation at all.
private final class InstantTabTransition: NSObject, UIViewControllerAnimatedTransitioning {
    func transitionDuration(using context: (any UIViewControllerContextTransitioning)?) -> TimeInterval { 0 }

    func animateTransition(using context: any UIViewControllerContextTransitioning) {
        if let toView = context.view(forKey: .to) {
            if let toVC = context.viewController(forKey: .to) {
                toView.frame = context.finalFrame(for: toVC)
            }
            context.containerView.addSubview(toView)
        }
        context.view(forKey: .from)?.removeFromSuperview()
        context.completeTransition(!context.transitionWasCancelled)
    }
}
