from check_api_coverage import live_endpoints, documented_paths, _normalize_path

def test_live_endpoints_parses_array():
    src = "const ENDPOINTS = ['/health', '/kb/search', '/auth/login'];"
    assert live_endpoints(src) == {"/health", "/kb/search", "/auth/login"}

def test_documented_paths_parses_yaml():
    y = "paths:\n  /health:\n    get: {}\n  /kb/search:\n    post: {}\n"
    assert documented_paths(y) == {"/health", "/kb/search"}

def test_express_params_normalized_to_openapi():
    src = "const ENDPOINTS = ['/kb/meeting/:id', '/kb/plan/:planId', '/health'];"
    assert live_endpoints(src) == {"/kb/meeting/{id}", "/kb/plan/{planId}", "/health"}

def test_normalize_path():
    assert _normalize_path("/kb/meeting/:id") == "/kb/meeting/{id}"
    assert _normalize_path("/kb/live/:id/append") == "/kb/live/{id}/append"
    assert _normalize_path("/health") == "/health"
