import Foundation
import TabminalMobileCore

extension TabminalServerEndpoint {
    var browserLoginURL: URL {
        guard var components = URLComponents(
            url: baseURL,
            resolvingAgainstBaseURL: false
        ) else {
            return baseURL
        }

        components.path = "/"
        components.query = nil
        components.fragment = nil
        return components.url ?? baseURL
    }
}
