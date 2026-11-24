import Foundation
import Security

let service =
    ProcessInfo.processInfo.environment["EXCALIDASH_KEYCHAIN_SERVICE"]
    ?? "org.excalidash.codex-mcp"
let account = "excalidash"
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account
]

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func requireSuccess(_ status: OSStatus) {
    guard status == errSecSuccess else {
        fail("ExcaliDash Keychain operation failed (\(status)).")
    }
}

func validToken(_ token: String) -> Bool {
    token.range(of: #"^exdm_[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
}

switch CommandLine.arguments.dropFirst().first {
case "store":
    guard let token = readLine(), validToken(token) else {
        fail("Expected an ExcaliDash token on standard input.")
    }
    let data = Data(token.utf8)
    var entry = query
    entry[kSecValueData as String] = data
    let status = SecItemAdd(entry as CFDictionary, nil)
    if status == errSecDuplicateItem {
        requireSuccess(SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary))
    } else {
        requireSuccess(status)
    }
case "headers":
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    requireSuccess(SecItemCopyMatching(lookup as CFDictionary, &result))
    guard let data = result as? Data, let token = String(data: data, encoding: .utf8), validToken(token) else {
        fail("The ExcaliDash Keychain item has an invalid value.")
    }
    let headers = try JSONSerialization.data(withJSONObject: ["Authorization": "Bearer " + token])
    FileHandle.standardOutput.write(headers)
case "remove":
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecItemNotFound { requireSuccess(status) }
default:
    fail("Usage: excalidash-codex-keychain store|headers|remove")
}
