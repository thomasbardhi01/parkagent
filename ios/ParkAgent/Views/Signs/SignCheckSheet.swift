import AVFoundation
import PhotosUI
import SwiftUI

/// "Check the signs" for one park (Issue N). The camera is the way in; a
/// photo already taken is the fallback (and the only way when the camera
/// is off). The photos are read on the phone; the verdict is advice, and
/// the one thing the driver can take from it is a shorter stay.
struct SignCheckSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: SignCheckModel
    @State private var showingCamera = false
    @State private var pickerItem: PhotosPickerItem?

    init(model: SignCheckModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                Text(SignCopy.title)
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                    .padding(.top, Spacing.half)
                switch model.phase {
                case .capturing:
                    capture
                case .reading, .checking:
                    HStack(spacing: Spacing.half) {
                        ProgressView()
                        Text(SignCopy.reading).font(.secondaryText).foregroundStyle(Color.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("signCheck.reading")
                case .done(let check):
                    result(check)
                case .failed(let message):
                    Text(message)
                        .font(.secondaryText)
                        .foregroundStyle(Color.danger)
                        .accessibilityIdentifier("signCheck.error")
                    Button(SignCopy.startOver) { model.startOver() }
                        .buttonStyle(.secondary)
                        .accessibilityIdentifier("signCheck.startOverButton")
                }
            }
            .padding(Spacing.unit)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.appBackground)
        .interactiveDismissDisabled(model.phase == .reading || model.phase == .checking || model.accepting)
        .fullScreenCover(isPresented: $showingCamera) {
            CameraCapture { image in
                if let image { model.add(image) }
                showingCamera = false
            }
            .ignoresSafeArea()
        }
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                    model.add(image)
                }
                pickerItem = nil
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("signCheck.view")
    }

    // MARK: - Capture

    @ViewBuilder
    private var capture: some View {
        Text(SignCopy.intro)
            .font(.secondaryText)
            .foregroundStyle(Color.textSecondary)
        if !model.photos.isEmpty {
            HStack(spacing: Spacing.half) {
                ForEach(Array(model.photos.enumerated()), id: \.offset) { index, photo in
                    Image(uiImage: photo)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 88, height: 88)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.button))
                        .overlay(alignment: .topTrailing) {
                            Button {
                                model.removePhoto(at: index)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.white, Color.ink.opacity(0.6))
                            }
                            .accessibilityLabel("Remove photo \(index + 1)")
                            .padding(Spacing.quarter)
                        }
                }
            }
            .accessibilityIdentifier("signCheck.photos")
        }
        if model.canAddPhoto {
            if cameraUsable {
                Button(SignCopy.takePhoto) { showingCamera = true }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("signCheck.takePhotoButton")
            } else if cameraDenied {
                Text(SignCopy.cameraOff)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("signCheck.cameraOffNote")
            }
            PhotosPicker(selection: $pickerItem, matching: .images) {
                Text(SignCopy.choosePhoto).frame(maxWidth: .infinity)
            }
            .buttonStyle(.secondary)
            .accessibilityIdentifier("signCheck.choosePhotoButton")
            #if DEBUG
            if LaunchOverrides.uiTesting {
                // The simulator has no camera: a rendered sign, so the UI
                // test still runs the real on-device reading.
                Button("Use a test sign") { model.add(SignFixtureImage.oneHourLimit()) }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("signCheck.debugFixtureSignButton")
            }
            #endif
        }
        Toggle(SignCopy.keepPhoto, isOn: $model.storePhoto)
            .font(.captionText)
            .foregroundStyle(Color.textSecondary)
            .accessibilityIdentifier("signCheck.keepPhotoToggle")
        Button(SignCopy.read) { Task { await model.check() } }
            .buttonStyle(.primary)
            .disabled(!model.canRead)
            .accessibilityIdentifier("signCheck.readButton")
    }

    private var cameraUsable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera) && !cameraDenied
    }

    private var cameraDenied: Bool {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        return status == .denied || status == .restricted
    }

    // MARK: - Result

    @ViewBuilder
    private func result(_ check: SignCheckResponse) -> some View {
        Text(SignCopy.headline(check.verdict))
            .font(.bodyText)
            .foregroundStyle(Color.textPrimary)
            .accessibilityIdentifier("signCheck.verdict.\(check.verdict.rawValue)")
        Text(SignCopy.detail(check))
            .font(.secondaryText)
            .foregroundStyle(Color.textSecondary)
            .accessibilityIdentifier("signCheck.detail")
        let reasons = check.reasons.compactMap(SignCopy.reason)
        if !reasons.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                ForEach(reasons, id: \.self) { reason in
                    Label(reason, systemImage: "exclamationmark.triangle")
                        .font(.captionText)
                        .foregroundStyle(Color.textPrimary)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("signCheck.reasons")
        }
        if !check.rules.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                ForEach(check.rules, id: \.self) { rule in
                    Text(SignCopy.rule(rule)).font(.captionText).foregroundStyle(Color.textSecondary)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("signCheck.rules")
        }
        if let offer = check.offer {
            if let accepted = model.accepted {
                Text(SignCopy.accepted(accepted.maxStayMinutes))
                    .font(.secondaryText)
                    .foregroundStyle(Color.success)
                    .accessibilityIdentifier("signCheck.acceptedNote")
            } else {
                Button {
                    Task { await model.accept() }
                } label: {
                    HStack(spacing: Spacing.half) {
                        if model.accepting { ProgressView().controlSize(.small).tint(.white) }
                        Text(SignCopy.accept(offer.maxStayMinutes))
                    }
                }
                .buttonStyle(.primary)
                .disabled(model.accepting)
                .accessibilityIdentifier("signCheck.acceptButton")
                if let error = model.acceptError {
                    Text(error).font(.captionText).foregroundStyle(Color.danger)
                        .accessibilityIdentifier("signCheck.acceptError")
                }
            }
        }
        Text(SignCopy.advisory)
            .font(.captionText)
            .foregroundStyle(Color.textSecondary)
            .accessibilityIdentifier("signCheck.advisoryNote")
        if check.verdict == .unreadable {
            Button(SignCopy.startOver) { model.startOver() }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("signCheck.startOverButton")
        }
        Button(SignCopy.done) { dismiss() }
            .buttonStyle(.secondary)
            .accessibilityIdentifier("signCheck.doneButton")
    }
}

/// The system camera, for one photo at a time.
private struct CameraCapture: UIViewControllerRepresentable {
    let onFinish: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?) -> Void
        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            onFinish(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onFinish(nil) }
    }
}

#if DEBUG
/// A sign drawn in code, for UI tests and previews: black capitals on
/// white, the way a curb sign photographs head-on.
enum SignFixtureImage {
    static func oneHourLimit() -> UIImage { render(["1 HOUR", "PARKING", "8AM - 6PM"]) }

    static func render(_ lines: [String]) -> UIImage {
        let size = CGSize(width: 1200, height: 1500)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            let style = NSMutableParagraphStyle()
            style.alignment = .center
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 150, weight: .heavy),
                .foregroundColor: UIColor.black,
                .paragraphStyle: style,
            ]
            for (i, line) in lines.enumerated() {
                let rect = CGRect(x: 0, y: 250 + CGFloat(i) * 300, width: size.width, height: 220)
                (line as NSString).draw(in: rect, withAttributes: attributes)
            }
        }
    }
}
#endif
