import SafariServices
import SwiftUI

/// SFSafariViewController in a sheet — SpotHero checkout and Link
/// approvals stay in a first-party browser context (autofill, no cookie
/// sharing with our code, visible URL).
struct SafariSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
