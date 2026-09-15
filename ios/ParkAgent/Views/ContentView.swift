import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "parkingsign.circle")
                .font(.system(size: 48))
            Text("ParkAgent")
                .font(.title)
            Text(AppConfig.apiBaseURL?.absoluteString ?? "API_BASE_URL not set")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
