import SwiftUI
import SharedProtocol

/// MEGA sign-in, then the 6-digit code to compare with the desktop.
struct SyncEnrollSheet: View {
    @EnvironmentObject var syncStore: SyncStore
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""
    @State private var name = "iPhone"

    var body: some View {
        NavigationStack {
            Group {
                switch syncStore.enrollStep {
                case .sas(let code):
                    VStack(spacing: 16) {
                        Text("Check the desktop").font(.title2.bold())
                        Text(code).font(.system(.largeTitle, design: .monospaced)).tracking(6)
                            .accessibilityLabel("Pairing code \(code.map(String.init).joined(separator: " "))")
                        Text("Press Codes match on the desktop only if this is the same code.").font(.footnote).multilineTextAlignment(.center)
                        ProgressView("Waiting for the desktop…")
                    }.padding()
                case .working(let text):
                    ProgressView(text).padding()
                case .failed(let text):
                    VStack { Image(systemName: "exclamationmark.triangle").font(.largeTitle); Text("Could not add this iPhone").font(.headline); Text(text).multilineTextAlignment(.center) }.padding()
                case .done:
                    VStack { Image(systemName: "checkmark.circle").font(.largeTitle); Text("Sync is on").font(.headline); Text("The desktop's snapshot will appear in History.").multilineTextAlignment(.center) }.padding()
                default:
                    Form {
                        Section("MEGA account") {
                            TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress).autocapitalization(.none)
                            SecureField("Password", text: $password).textContentType(.password)
                        }
                        Section("This iPhone") { TextField("Name", text: $name) }
                        Section {
                            Button("Continue") { syncStore.enroll(email: email, password: password, name: name) }
                                .disabled(email.isEmpty || password.isEmpty || name.isEmpty)
                        }
                    }
                }
            }
            .navigationTitle("Add this iPhone")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { syncStore.cancelEnrollment(); dismiss() } } }
        }
    }
}
