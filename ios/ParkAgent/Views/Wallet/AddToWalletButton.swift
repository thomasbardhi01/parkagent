import PassKit
import SwiftUI

/// "Add to Apple Pay", behind FeatureFlags.applePayProvisioning. Off (the
/// default until Apple grants the payment-pass-provisioning entitlement —
/// see CLAUDE.md), the action explains "coming soon". On, it presents
/// PKAddPaymentPassViewController with the Stripe call path stubbed in
/// PushProvisioningCoordinator.
struct AddToWalletButton: View {
    let card: ParkAgentCard
    @State private var showComingSoon = false
    @State private var isProvisioning = false

    var body: some View {
        CardActionButton(
            icon: "wallet.bifold",
            label: "Add to Wallet",
            identifier: "wallet.addToAppleWalletButton"
        ) {
            if FeatureFlags.applePayProvisioning {
                isProvisioning = true
            } else {
                showComingSoon = true
            }
        }
        .alert("Coming soon", isPresented: $showComingSoon) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Adding the ParkAgent card to Apple Wallet is pending Apple's approval.")
                .accessibilityIdentifier("wallet.addToAppleWalletComingSoon")
        }
        .sheet(isPresented: $isProvisioning) {
            AddPaymentPassSheet(card: card)
                .ignoresSafeArea()
        }
    }
}

/// PKAddPaymentPassViewController wrapper. The delegate is where Stripe's
/// push-provisioning exchange happens; until the entitlement and the Stripe
/// iOS SDK land, generateRequest completes empty and Apple's UI reports the
/// failure — the flag keeps real users out of this path.
private struct AddPaymentPassSheet: UIViewControllerRepresentable {
    let card: ParkAgentCard
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> PushProvisioningCoordinator {
        PushProvisioningCoordinator(onFinish: { dismiss() })
    }

    func makeUIViewController(context: Context) -> UIViewController {
        let configuration = PKAddPaymentPassRequestConfiguration(encryptionScheme: .ECC_V2)
        configuration?.cardholderName = card.cardholderName ?? ""
        configuration?.primaryAccountSuffix = card.last4
        configuration?.localizedDescription = "ParkAgent card"
        guard let configuration,
              let controller = PKAddPaymentPassViewController(
                  requestConfiguration: configuration,
                  delegate: context.coordinator
              )
        else {
            // No entitlement (or unsupported device): PassKit refuses the
            // controller. The flag should have kept us out of here.
            return UIHostingController(rootView: EmptyStateView(
                icon: "wallet.bifold",
                title: "Apple Pay unavailable",
                message: "This build is not yet approved for push provisioning."
            ))
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}

final class PushProvisioningCoordinator: NSObject, PKAddPaymentPassViewControllerDelegate {
    private let onFinish: () -> Void

    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
    }

    func addPaymentPassViewController(
        _ controller: PKAddPaymentPassViewController,
        generateRequestWithCertificateChain certificates: [Data],
        nonce: Data,
        nonceSignature: Data,
        completionHandler handler: @escaping (PKAddPaymentPassRequest) -> Void
    ) {
        // Stripe call path: STPPushProvisioningContext(keyProvider:) would
        // exchange (certificates, nonce, nonceSignature) for encrypted card
        // data, with the key provider POSTing the SDK's api_version to
        // GET /card/reveal for the ephemeral key. Wire it here when the
        // entitlement is granted and the Stripe iOS SDK is added.
        handler(PKAddPaymentPassRequest())
    }

    func addPaymentPassViewController(
        _ controller: PKAddPaymentPassViewController,
        didFinishAdding pass: PKPaymentPass?,
        error: Error?
    ) {
        onFinish()
    }
}
