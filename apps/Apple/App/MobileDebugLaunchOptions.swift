import Foundation

struct MobileDebugLaunchOptions {
    let mainURL: String?
    let password: String?
    let hostAlias: String?
    let autoLogin: Bool
    let presentSidebar: Bool
    let presentWorkspace: Bool

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
        let sidebarValue = environment["TABMINAL_MOBILE_DEBUG_PRESENT_SIDEBAR"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let workspaceValue =
            environment["TABMINAL_MOBILE_DEBUG_PRESENT_WORKSPACE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        self.mainURL = (url?.isEmpty == false) ? url : nil
        self.password = (password?.isEmpty == false) ? password : nil
        self.hostAlias = (hostAlias?.isEmpty == false) ? hostAlias : nil
        self.autoLogin = autoLoginValue == "1"
            || autoLoginValue == "true"
            || autoLoginValue == "yes"
        self.presentSidebar = sidebarValue == "1"
            || sidebarValue == "true"
            || sidebarValue == "yes"
        self.presentWorkspace = workspaceValue == "1"
            || workspaceValue == "true"
            || workspaceValue == "yes"
    }

    var isEnabled: Bool {
        mainURL != nil
            || password != nil
            || hostAlias != nil
            || autoLogin
            || presentSidebar
            || presentWorkspace
    }
}
