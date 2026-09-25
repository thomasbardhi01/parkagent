import PassKit
import StripeApplePay
import StripeCore
import StripePaymentSheet
import UIKit

/// The only file that touches the Stripe SDK. Saves the user's own card for
/// the ParkAgent card's per-session holds by confirming a SetupIntent (from
/// POST /wallet/setup-intent) client-side — Apple Pay first through
/// STPApplePayContext, or card entry through PaymentSheet. Nothing is
/// charged here: a SetupIntent only saves the card. Mock secrets
/// (seti_mock_…) never reach the SDK.
enum StripeWallet {
    /// No STRIPE_PUBLISHABLE_KEY in this build: a developer-facing hint in
    /// Debug, a plain sentence for everyone else.
    private static var notConfiguredMessage: String {
        #if DEBUG
        "Stripe is not configured. Add STRIPE_PUBLISHABLE_KEY to Config.xcconfig."
        #else
        "Saving a card isn't available in this version of ParkAgent."
        #endif
    }

    /// Call once at launch; a missing key just means the live paths report
    /// "not configured" when reached.
    @MainActor
    static func configure() {
        if let key = AppConfig.stripePublishableKey {
            STPAPIClient.shared.publishableKey = key
        }
    }

    @MainActor
    static var applePayAvailable: Bool {
        StripeAPI.deviceSupportsApplePay()
    }

    enum Outcome: Sendable, Equatable {
        case saved
        case canceled
        case failed(String)
    }

    /// The UI tests and previews run on the mock server, whose intents are
    /// fixtures: finish without presenting anything. Never in Release.
    private static func isMockSecret(_ clientSecret: String) -> Bool {
        #if DEBUG
        clientSecret.hasPrefix("seti_mock_")
        #else
        false
        #endif
    }

    /// STPApplePayContext holds its delegate weakly; this keeps it alive
    /// for the duration of one presentation.
    @MainActor private static var activeDelegate: ApplePayDelegate?

    /// Apple Pay sheet for saving a card: no charge today — the summary
    /// says what the card will be used for.
    @MainActor
    static func saveWithApplePay(clientSecret: String, merchantId: String) async -> Outcome {
        if isMockSecret(clientSecret) { return .saved }
        guard AppConfig.stripePublishableKey != nil else {
            return .failed(notConfiguredMessage)
        }
        let request = StripeAPI.paymentRequest(
            withMerchantIdentifier: merchantId,
            country: "US",
            currency: "USD"
        )
        // Saving a card charges nothing now; each parking session holds only
        // what the meter costs (plus a small buffer) and takes the actual.
        request.paymentSummaryItems = [
            PKPaymentSummaryItem(
                label: "ParkAgent — parking as you go",
                amount: NSDecimalNumber.zero,
                type: .pending
            )
        ]
        let outcome = await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
            let delegate = ApplePayDelegate(clientSecret: clientSecret) { outcome in
                continuation.resume(returning: outcome)
            }
            guard let context = STPApplePayContext(paymentRequest: request, delegate: delegate) else {
                continuation.resume(returning: .failed("Apple Pay is not available on this device."))
                return
            }
            activeDelegate = delegate
            context.presentApplePay()
        }
        activeDelegate = nil
        return outcome
    }

    /// PaymentSheet card entry (Apple Pay also offered at its top).
    @MainActor
    static func saveWithCardForm(clientSecret: String, merchantId: String) async -> Outcome {
        if isMockSecret(clientSecret) { return .saved }
        guard AppConfig.stripePublishableKey != nil else {
            return .failed(notConfiguredMessage)
        }
        guard let presenter = topViewController() else {
            return .failed("Nothing to present the card form from.")
        }
        var configuration = PaymentSheet.Configuration()
        configuration.merchantDisplayName = "ParkAgent"
        configuration.applePay = .init(merchantId: merchantId, merchantCountryCode: "US")
        let sheet = PaymentSheet(setupIntentClientSecret: clientSecret, configuration: configuration)
        return await withCheckedContinuation { continuation in
            sheet.present(from: presenter) { result in
                switch result {
                case .completed: continuation.resume(returning: .saved)
                case .canceled: continuation.resume(returning: .canceled)
                case .failed(let error): continuation.resume(returning: .failed(error.localizedDescription))
                }
            }
        }
    }

    @MainActor
    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}

/// STPApplePayContext delegate: hand over the SetupIntent's client secret
/// when the user authorizes, report the final status. Deliberately
/// nonisolated with immutable state — Stripe calls back on the main queue,
/// and the continuation-resuming closure is Sendable.
private final class ApplePayDelegate: NSObject, ApplePayContextDelegate {
    private let clientSecret: String
    private let finish: @Sendable (StripeWallet.Outcome) -> Void

    init(clientSecret: String, finish: @escaping @Sendable (StripeWallet.Outcome) -> Void) {
        self.clientSecret = clientSecret
        self.finish = finish
    }

    func applePayContext(
        _ context: STPApplePayContext,
        didCreatePaymentMethod paymentMethod: StripeAPI.PaymentMethod,
        paymentInformation: PKPayment,
        completion: @escaping STPIntentClientSecretCompletionBlock
    ) {
        // A SetupIntent secret: STPApplePayContext confirms it as a setup.
        completion(clientSecret, nil)
    }

    func applePayContext(
        _ context: STPApplePayContext,
        didCompleteWith status: STPApplePayContext.PaymentStatus,
        error: (any Error)?
    ) {
        switch status {
        case .success: finish(.saved)
        case .userCancellation: finish(.canceled)
        case .error: finish(.failed(error?.localizedDescription ?? "The card wasn't saved."))
        }
    }
}
