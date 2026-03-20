import Foundation

struct MobileDebugLaunchOptions {
    let mainURL: String?
    let password: String?
    let hostAlias: String?
    let autoLogin: Bool

    static let current = MobileDebugLaunchOptions(
        environment: ProcessInfo.processInfo.environment
    )

    init(environment: [String: String]) {
        let url = environment["TABMINAL_MOBILE_DEBUG_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let password = environment["TABMINAL_MOBILE_DEBUG_PASSWORD"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hostAlias = environment["TABMINAL_MOBILE_DEBUG_HOST"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let autoLoginValue = environment["TABMINAL_MOBILE_DEBUG_AUTO_LOGIN"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        self.mainURL = (url?.isEmpty == false) ? url : nil
        self.password = (password?.isEmpty == false) ? password : nil
        self.hostAlias = (hostAlias?.isEmpty == false) ? hostAlias : nil
        self.autoLogin = autoLoginValue == "1"
            || autoLoginValue == "true"
            || autoLoginValue == "yes"
    }

    var isEnabled: Bool {
        mainURL != nil || password != nil || hostAlias != nil || autoLogin
    }
}
