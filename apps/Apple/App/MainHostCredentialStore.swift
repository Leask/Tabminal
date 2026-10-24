import Foundation
import Security
import TabminalMobileCore

struct MainHostCredentialStore {
    private let store = TabminalKeychainCredentialStore()

    func hasLogin(for server: TabminalServerEndpoint) -> Bool {
        let key = TabminalAuthSession.credentialKey(for: server)
        guard let tokens = try? store.load(for: key) else { return false }
        return tokens.refreshTokenExpiresAt > Date()
    }

    func discardLegacyToken() {
        // Never migrate the old reusable password hash into token auth.
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "com.leask.tabminal.mobile.main-host",
            kSecAttrAccount: "auth-token"
        ]
        SecItemDelete(query as CFDictionary)
    }
}
