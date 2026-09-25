import PassKit
import StripeApplePay
import StripeCore
import StripePaymentSheet
import UIKit

/// The only file that touches the Stripe SDK. Confirms a top-up
/// PaymentIntent (from POST /card/funding/topup-intent) client-side —
/// Apple Pay through STPApplePayContext, or the card form through
/// PaymentSheet. Dry-run secrets (pi_dryrun_…) never get here.
enum StripeTopup {
    static let merchantId = "merchant.com.thomasbardhi.parkagent"

    /// Call once at launch; a missing key just means the live confirm paths
    /// report "not configured" when reached.
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

    enum Outcome: Sendable {
        case paid
        case canceled
        case failed(String)
    }

    /// STPApplePayContext holds its delegate weakly; this keeps it alive
    /// for the duration of one presentation.
    @MainActor private static var activeDelegate: ApplePayDelegate?

    /// Present the Apple Pay sheet for the intent.
    @MainActor
    static func presentApplePay(clientSecret: String, amountUsd: Double) async -> Outcome {
        guard AppConfig.stripePublishableKey != nil else {
            return .failed("Stripe is not configured. Add STRIPE_PUBLISHABLE_KEY to Config.xcconfig.")
        }
        let request = StripeAPI.paymentRequest(
            withMerchantIdentifier: merchantId,
            country: "US",
            currency: "USD"
        )
        request.paymentSummaryItems = [
            PKPaymentSummaryItem(label: "ParkAgent card", amount: NSDecimalNumber(value: amountUsd))
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

    /// PaymentSheet fallback: the plain card form.
    @MainActor
    static func presentCardForm(clientSecret: String) async -> Outcome {
        guard AppConfig.stripePublishableKey != nil else {
            return .failed("Stripe is not configured. Add STRIPE_PUBLISHABLE_KEY to Config.xcconfig.")
        }
        guard let presenter = topViewController() else {
            return .failed("Nothing to present the card form from.")
        }
        var configuration = PaymentSheet.Configuration()
        configuration.merchantDisplayName = "ParkAgent"
        let sheet = PaymentSheet(paymentIntentClientSecret: clientSecret, configuration: configuration)
        return await withCheckedContinuation { continuation in
            sheet.present(from: presenter) { result in
                switch result {
                case .completed: continuation.resume(returning: .paid)
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

/// STPApplePayContext delegate: hand over the client secret when the user
/// authorizes, report the final status. Deliberately nonisolated with
/// immutable state — Stripe calls back on the main queue, and the
/// continuation-resuming closure is Sendable.
private final class ApplePayDelegate: NSObject, ApplePayContextDelegate {
    private let clientSecret: String
    private let finish: @Sendable (StripeTopup.Outcome) -> Void

    init(clientSecret: String, finish: @escaping @Sendable (StripeTopup.Outcome) -> Void) {
        self.clientSecret = clientSecret
        self.finish = finish
    }

    func applePayContext(
        _ context: STPApplePayContext,
        didCreatePaymentMethod paymentMethod: StripeAPI.PaymentMethod,
        paymentInformation: PKPayment,
        completion: @escaping STPIntentClientSecretCompletionBlock
    ) {
        completion(clientSecret, nil)
    }

    func applePayContext(
        _ context: STPApplePayContext,
        didCompleteWith status: STPApplePayContext.PaymentStatus,
        error: (any Error)?
    ) {
        switch status {
        case .success: finish(.paid)
        case .userCancellation: finish(.canceled)
        case .error: finish(.failed(error?.localizedDescription ?? "The payment did not go through."))
        }
    }
}
