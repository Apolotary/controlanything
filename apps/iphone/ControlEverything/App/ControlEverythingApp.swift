import SwiftUI

@main
struct ControlEverythingApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Typo.registerBundledFonts()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .onOpenURL { model.open(url: $0) }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.appBecameActive() }
                }
        }
    }
}

/// connect → pairing → deck, with the screen wash, local-effect chips, banners and ARM requests on top.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            HUDBackground()
            Group {
                switch model.screen {
                case .connect: ConnectView()
                case .pairing: PairingView()
                case .deck: DeckView()
                }
            }
            .transition(.opacity)

            VStack(spacing: 8) {
                if let b = model.banner { BannerView(banner: b).padding(.top, model.screen == .deck ? 44 : 4) }
                Spacer()
                LocalEffectsStrip().padding(.bottom, model.screen == .deck ? 70 : 16)
            }
            .animation(.easeOut(duration: 0.2), value: model.banner)

            if let arm = model.arms.first, model.screen == .deck {
                VStack {
                    Spacer()
                    ArmCard(arm: arm)
                }
                .background(Neon.void.opacity(0.55).ignoresSafeArea())
                .transition(.move(edge: .bottom))
            }

            ScreenWashOverlay()
        }
        .animation(.easeOut(duration: 0.2), value: model.screen)
        .task {
            #if DEBUG
            model.applyLaunchArguments()
            #endif
            if model.credentials != nil, model.socketState == .idle { model.connectSocket() }
        }
        .onChange(of: model.screen) { _, s in
            // a control deck should not go to sleep in the middle of a demo
            UIApplication.shared.isIdleTimerDisabled = (s == .deck)
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = (model.screen == .deck) }
    }
}
