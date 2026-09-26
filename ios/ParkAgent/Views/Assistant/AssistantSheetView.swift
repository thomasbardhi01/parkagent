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
    /// Drives the scroll-to-bottom when the keyboard rises.
    @FocusState private var inputFocused: Bool
    /// An approved Link garage payment's card, on screen for checkout.
    @State private var linkCard: LinkCardDetails?
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
            // The living wash behind the sheet left the bar transparent, so
            // scrolled messages ran under the title. Material gives it a
            // surface to sit on while still reading as part of the sheet.
            .toolbarBackground(.regularMaterial, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
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
        // Dismissing the sheet mid-dictation must release the mic: stop()
        // tears down the tap, the recognition task, and the .record audio
        // session (which otherwise keeps other apps' audio ducked).
        .onDisappear { speech.stop() }
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
                            emptyState(model)
                        }
                        ForEach(model.messages) { message in
                            MessageBubble(message: message)
                            if message.id == model.messages.last?.id, !model.activeSuggestions.isEmpty {
                                suggestionChips(model)
                            }
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
                // No .defaultScrollAnchor(.bottom) here: pinning the whole
                // scroll view to the bottom re-lays-out a tall plan card
                // under the reader's finger (it moved the Sign off button
                // out from under a tap). The explicit scrollTo calls below
                // are what keep the newest message in view.
                //
                // A flick through the transcript puts the keyboard away.
                .scrollDismissesKeyboard(.interactively)
                // The newest reply stays visible through all three things
                // that grow it: a new bubble, the reply streaming in, and
                // the plan card landing underneath it.
                .onChange(of: model.messages) { scrollToBottom(proxy) }
                .onChange(of: model.messages.last?.text) { scrollToBottom(proxy) }
                .onChange(of: model.proposedPlan?.planId) { scrollToBottom(proxy) }
                // The keyboard rising used to cover the reply that just
                // arrived: SwiftUI shrinks the scroll view but keeps the
                // offset, so follow it back down.
                .onChange(of: inputFocused) { _, focused in
                    guard focused else { return }
                    Task {
                        // One hop after the keyboard's frame change, or the
                        // scroll lands at the pre-keyboard bottom.
                        try? await Task.sleep(for: .milliseconds(350))
                        scrollToBottom(proxy)
                    }
                }
            }
            if let approved = model.approvedLinkCheckout {
                linkCheckoutBar(model, approved: approved)
            }
            speechArea
            inputBar(model)
        }
        .sheet(item: $linkCard) { card in
            LinkCardSheet(card: card, checkoutURL: model.approvedLinkCheckout?.checkoutURL)
                .presentationDetents([.medium])
                .onDisappear { model.approvedLinkCheckout = nil }
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
        #if DEBUG
        .overlay(alignment: .bottomTrailing) {
            if uiTesting, let link = model.externalLink {
                Button(link.kind == .garageCheckout ? "garageCheckout" : "linkApproval") {
                    model.externalLink = nil
                    if link.kind == .linkApproval {
                        Task { await model.syncPendingLinkApproval() }
                    }
                }
                .font(.system(size: 8))
                .accessibilityIdentifier("assistant.externalLinkProbe")
            }
        }
        #endif
    }

    /// After Link approves a garage: the one-time card (Face ID) and the
    /// garage's own checkout, one tap away.
    private func linkCheckoutBar(_ model: AssistantModel, approved: AssistantModel.ApprovedLinkCheckout) -> some View {
        Button {
            Task {
                linkCard = await appModel.wallet.revealLinkCard(
                    spendRequestId: approved.spendRequestId,
                    api: appModel.api
                )
            }
        } label: {
            Label("Show Link card for checkout", systemImage: "creditcard")
        }
        .buttonStyle(.secondary)
        .padding(.horizontal, Spacing.unit)
        .padding(.bottom, Spacing.half)
        .accessibilityIdentifier("assistant.showLinkCard")
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    @ViewBuilder
    private func emptyState(_ model: AssistantModel) -> some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            VStack(alignment: .leading, spacing: Spacing.half) {
                Text("Find a spot, or plan a day.")
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Text("Ask in your own words — a place, a time, how long.")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
            }
            // Starters in the user's own city: real streets and landmarks
            // beat a generic example at showing what this understands.
            FlowLayout(spacing: Spacing.half) {
                ForEach(CityCatalog.assistantStarters(for: appModel.effectiveCity), id: \.self) { prompt in
                    Button {
                        inputFocused = false
                        Task { await model.send(prompt) }
                    } label: {
                        Text(prompt)
                            .font(.captionText)
                            .foregroundStyle(Color.textPrimary)
                            .padding(.horizontal, Spacing.unit)
                            .padding(.vertical, Spacing.half)
                            .background(Color.appBackground)
                            .clipShape(Capsule())
                            .overlay(Capsule().strokeBorder(Color.separator, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("assistant.promptChip")
                }
            }
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        // .contain keeps the chips queryable — an identifier alone would
        // publish the card as one element and hide them.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.emptyState")
    }

    /// The question's answers as chips: a tap sends that answer as the
    /// user's own message, exactly as if they'd typed it.
    private func suggestionChips(_ model: AssistantModel) -> some View {
        FlowLayout(spacing: Spacing.half) {
            ForEach(Array(model.activeSuggestions.enumerated()), id: \.offset) { index, suggestion in
                Button {
                    inputFocused = false
                    Task { await model.send(suggestion.reply) }
                } label: {
                    Text(suggestion.label)
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.actionCoralLink)
                        .padding(.horizontal, Spacing.unit)
                        .padding(.vertical, Spacing.half)
                        .background(Color.surface)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(Color.actionCoralLink.opacity(0.5), lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("assistant.suggestion.\(index)")
                .accessibilityHint("Sends this answer")
            }
        }
        .padding(.leading, Spacing.half)
        .frame(maxWidth: .infinity, alignment: .leading)
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
                // Link pays only when it's the Wallet's active way to pay.
                linkConnected: appModel.linkWalletConnected && appModel.wallet.activeSource == .linkWallet
            ) { option in
                Task { await model.confirm(planId: plan.planId, optionId: option.id) }
            }
        case .itinerary(let day):
            ItineraryPlanCard(
                plan: day,
                confirming: model.phase == .confirming,
                // Link pays only when it's the Wallet's active way to pay.
                linkConnected: appModel.linkWalletConnected && appModel.wallet.activeSource == .linkWallet,
                price: { stops in try await model.price(planId: plan.planId, stops: stops) }
            ) { stops in
                // The card's edits go with the sign-off; the server
                // re-prices them and re-checks the cap before storing.
                Task { await model.confirm(planId: plan.planId, optionId: nil, stops: stops) }
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
                .focused($inputFocused)
                .submitLabel(.send)
                .accessibilityIdentifier("assistant.inputField")
                .onSubmit { send(model) }

            Button {
                // Dictating and typing compete for the same field; put the
                // keyboard away before the mic opens.
                inputFocused = false
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
                send(model)
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
        // Material, not clear: messages scrolling past used to read through
        // the bar. It still lets the living wash show, just not the text.
        .background(.regularMaterial)
        .overlay(alignment: .top) { Divider() }
    }

    /// Send and put the keyboard away: the reply and its card need the
    /// screen more than the field does.
    private func send(_ model: AssistantModel) {
        inputFocused = false
        Task { await model.send() }
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
