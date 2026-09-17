public enum BridgeSubmitIntent: Equatable {
    case search
    case advanceSelection

    public static func decide(query: String, lastSearchedQuery: String, hasResults: Bool) -> BridgeSubmitIntent {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedQuery.isEmpty && normalizedQuery != lastSearchedQuery {
            return .search
        }
        return hasResults ? .advanceSelection : .search
    }
}
