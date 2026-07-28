import Foundation

struct Route {
    let path: String
}

final class Router {
    private var routes: [Route] = []

    func register(_ path: String) {
        routes.append(Route(path: path))
    }
}
