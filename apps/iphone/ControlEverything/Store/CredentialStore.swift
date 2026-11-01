import Foundation
import Security

/// What this iPhone keeps after pairing. The token lives in the Keychain (this device only, after first unlock).
nonisolated struct Credentials: Codable, Sendable, Equatable {
    var server: ServerEndpoint
    var deviceId: String
    var deviceToken: String
    var name: String
    var pairedAt: Date
}

nonisolated enum CredentialStore {
    private static let service = "dev.controleverything.ios"
    private static let account = "device-credentials"

    static func load() -> Credentials? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }

    @discardableResult
    static func save(_ c: Credentials) -> Bool {
        guard let data = try? JSONEncoder().encode(c) else { return false }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(base as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            for (k, v) in attrs { add[k] = v }
            return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }

    static func clear() {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(q as CFDictionary)
    }
}

/// Non-secret preferences.
nonisolated enum Prefs {
    static var lastServerInput: String {
        get { UserDefaults.standard.string(forKey: "lastServerInput") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "lastServerInput") }
    }
    static var deviceName: String {
        get { UserDefaults.standard.string(forKey: "deviceName") ?? "iPhone" }
        set { UserDefaults.standard.set(newValue, forKey: "deviceName") }
    }
}
