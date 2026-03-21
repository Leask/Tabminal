import SwiftUI

extension View {
    @ViewBuilder
    func tabminalURLFieldTraits() -> some View {
#if os(iOS) || os(visionOS)
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .textContentType(.URL)
#else
        self
#endif
    }

    @ViewBuilder
    func tabminalNameFieldTraits() -> some View {
#if os(iOS) || os(visionOS)
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
#else
        self
#endif
    }

    @ViewBuilder
    func tabminalPasswordFieldTraits() -> some View {
#if os(iOS) || os(visionOS)
        self.textContentType(.password)
#else
        self
#endif
    }
}
