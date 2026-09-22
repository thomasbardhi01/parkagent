import SwiftUI

/// The conversational sheet: transcript, streamed reply, plan cards, and
/// the mic. Reached from Home's Ask button and the "Ask ParkAgent" Siri
/// intent.
struct AssistantSheetView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model: AssistantModel?
    @State private var speech = SpeechRecognizer()
    /// Prefilled question (Siri hands one in).
    var initialQuery: String?

    private var uiTesting: Bool { LaunchOverrides.uiTesting }

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    content(model)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Ask ParkAgent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            if model == nil {
                let fresh = AssistantModel(appModel: appModel)
                model = fresh
                if let initialQuery, !initialQuery.isEmpty {
                    await fresh.send(initialQuery)
                }
            }
        }
        .accessibilityIdentifier("assistant.sheet")
    }

    @ViewBuilder
    private func content(_ model: AssistantModel) -> some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Spacing.unit) {
                        if model.messages.isEmpty {
                            emptyState
                        }
                        ForEach(model.messages) { message in
                            MessageBubble(message: message)
                            if let plan = model.proposedPlan, message.planId == plan.planId {
                                planCards(model, plan: plan)
                                    .transition(
                                        reduceMotion
                                            ? .opacity
                                            : .move(edge: .bottom).combined(with: .opacity)
                                    )
                            }
                        }
                        if let errorText = model.errorText {
                            errorRow(errorText)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(Spacing.unit)
                    // Plan cards slide up and settle under their message; a
                    // fade under Reduce Motion.
                    .animation(
                        reduceMotion ? .easeInOut(duration: 0.2) : Motion.settle,
                        value: model.proposedPlan?.planId
                    )
                }
                .onChange(of: model.messages) {
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            speechArea
            inputBar(model)
        }
        // The living wash sits behind the whole conversation; the input bar
        // goes transparent so the depth reads through it.
        .background(LivingBackground().ignoresSafeArea())
        .onChange(of: speech.finishedTranscript) { _, transcript in
            // Dictation ended (tap or silence): the words land in the input
            // field for editing — sending stays a deliberate tap.
            if let transcript, !transcript.isEmpty {
                model.input = transcript
            }
            speech.acknowledge()
        }
        // UI tests can't drive SFSafariViewController; the probe records
        // that the deep link would have opened, and tapping it resolves
        // the approval through the same sync path the real sheet's
        // dismissal uses.
        .sheet(item: uiTesting ? .constant(nil) : $model.externalLink) { link in
            SafariSheet(url: link.url)
                .onDisappear {
                    if link.kind == .linkApproval {
                        Task { await model.syncPendingLinkApproval() }
                    }
                }
        }
        .overlay(alignment: .bottomTrailing) {
            if uiTesting, let link = model.externalLink {
                Button(link.kind == .spothero ? "spothero" : "linkApproval") {
                    model.externalLink = nil
                    if link.kind == .linkApproval {
                        Task { await model.syncPendingLinkApproval() }
                    }
                }
                .font(.system(size: 8))
                .accessibilityIdentifier("assistant.externalLinkProbe")
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            Text("Find a spot, or plan a day.")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text("Try: “Park me near the MFA at 2 for two hours” or “Plan my Boston day: coffee at 9, client at 10, lunch at 12.”")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .accessibilityIdentifier("assistant.emptyState")
    }

    private func errorRow(_ text: String) -> some View {
        HStack(spacing: Spacing.half) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.warningGold)
            Text(text)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .accessibilityIdentifier("assistant.errorRow")
    }

    @ViewBuilder
    private func planCards(_ model: AssistantModel, plan: AssistantReply.ProposedPlan) -> some View {
        switch plan.plan {
        case .singleSpot(let single):
            SingleSpotPlanCards(
                plan: single,
                confirming: model.phase == .confirming,
                linkConnected: appModel.linkWalletConnected
            ) { option in
                Task { await model.confirm(planId: plan.planId, optionId: option.id) }
            }
        case .itinerary(let day):
            ItineraryPlanCard(
                plan: day,
                confirming: model.phase == .confirming,
                linkConnected: appModel.linkWalletConnected
            ) { stops in
                // Edits before sign-off stay client-side; sign-off sends
                // the plan as proposed (server re-prices on PATCH after).
                _ = stops
                Task { await model.confirm(planId: plan.planId, optionId: nil) }
            }
        }
    }

    /// The live transcript while listening, or the denied/unavailable
    /// notice. Settles in above the input bar; a plain crossfade under
    /// Reduce Motion.
    @ViewBuilder
    private var speechArea: some View {
        Group {
            switch speech.state {
            case .listening:
                LiveTranscriptionPanel(speech: speech)
                    .transition(
                        reduceMotion
                            ? .opacity.animation(.easeInOut(duration: 0.2))
                            : .move(edge: .bottom).combined(with: .opacity)
                    )
            case .denied:
                SpeechNoticeRow(
                    icon: "mic.slash.fill",
                    message: "Dictation is off. Allow the microphone and speech recognition in Settings.",
                    showsOpenSettings: true,
                    dismiss: { speech.resetAvailability() }
                )
                .accessibilityIdentifier("assistant.speechDeniedNotice")
            case .unavailable:
                SpeechNoticeRow(
                    icon: "waveform.slash",
                    message: "Dictation isn't available right now. Check the connection, or type instead.",
                    dismiss: { speech.resetAvailability() }
                )
                .accessibilityIdentifier("assistant.speechUnavailableNotice")
            case .idle:
                EmptyView()
            }
        }
        .padding(.horizontal, Spacing.unit)
        .padding(.bottom, Spacing.half)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : Motion.settle, value: speech.state)
    }

    private func inputBar(_ model: AssistantModel) -> some View {
        @Bindable var model = model
        return HStack(spacing: Spacing.half) {
            TextField("Ask about parking…", text: $model.input, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color.surface)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                .accessibilityIdentifier("assistant.inputField")
                .onSubmit { Task { await model.send() } }

            Button {
                if speech.state == .listening {
                    // Stop only — the transcript lands in the field via
                    // finishedTranscript, editable before the user sends.
                    speech.stop()
                } else {
                    Task { await speech.start() }
                }
            } label: {
                Image(systemName: speech.state == .listening ? "stop.circle.fill" : "mic.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(
                        speech.state == .listening ? Color.actionCoralLink : Color.textSecondary
                    )
                    .frame(width: 44, height: 44)
            }
            .accessibilityIdentifier("assistant.micButton")

            Button {
                Task { await model.send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(
                        model.input.isEmpty || model.phase == .streaming
                            ? Color.steel : Color.actionCoral
                    )
                    .frame(width: 44, height: 44)
            }
            .disabled(model.input.isEmpty || model.phase == .streaming)
            .accessibilityIdentifier("assistant.sendButton")
        }
        .padding(.vertical, Spacing.half)
        .padding(.horizontal, Spacing.unit)
        .overlay(alignment: .top) { Divider() }
    }
}

private struct MessageBubble: View {
    let message: AssistantMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: Spacing.double) }
            Group {
                if message.text.isEmpty && message.role == .assistant {
                    TypingIndicator()
                        .padding(.vertical, 5)
                } else {
                    Text(message.text.isEmpty ? "…" : message.text)
                }
            }
            .font(.bodyText)
            .foregroundStyle(message.role == .user ? Color.white : Color.textPrimary)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(message.role == .user ? Color.actionCoral : Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            if message.role == .assistant { Spacer(minLength: Spacing.double) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(
            message.role == .user ? "assistant.userMessage" : "assistant.reply"
        )
    }
}
