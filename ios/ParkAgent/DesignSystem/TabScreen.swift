import SwiftUI

/// Chrome every tab root needs, in one place.
///
/// Two bugs this fixes, both seen on device:
///
/// 1. **Content under the tab bar.** The tab bar floats over the content,
///    and a scroll view's last rows ended up behind it — the final Settings
///    row and the Card tab's last transaction were unreachable. The bottom
///    content margin below clears it. It is a *margin*, not a safe-area
///    inset, so where the system already insets correctly this only adds
///    breathing room instead of double-counting.
///
/// 2. **Double exposure on tab switches.** Tab roots that never painted an
///    opaque background let the outgoing tab show through the incoming one
///    mid-transition. Every root paints `appBackground` now.
extension View {
    /// The root of a tab. Paints an opaque background and keeps scrolled
    /// content clear of the floating tab bar.
    func tabScreen() -> some View {
        self
            .background(Color.appBackground)
            .contentMargins(.bottom, TabScreenMetrics.bottomClearance, for: .scrollContent)
    }
}

enum TabScreenMetrics {
    /// Enough for the floating bar plus a little air. Deliberately a single
    /// constant: if the bar's height changes, this is the one edit.
    static let bottomClearance: CGFloat = 28
}
