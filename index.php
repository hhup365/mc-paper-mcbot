<?php

declare(strict_types=1);

$FILE_NAME  = 'config.json';
$SECRET_KEY = getenv('CONFIG_SECRET') ?: 'MySuperSecret';

if (!file_exists('.htaccess')) {
    @file_put_contents('.htaccess', "<Files \"{$FILE_NAME}\">\n    Require all denied\n</Files>\n");
}
if (!file_exists($FILE_NAME)) {
    @file_put_contents($FILE_NAME, "[]");
}

$client_secret = '';
if (isset($_SERVER['HTTP_X_SECRET'])) {
    $client_secret = $_SERVER['HTTP_X_SECRET'];
} elseif (function_exists('getallheaders')) {
    foreach (getallheaders() as $k => $v) {
        if (strcasecmp($k, 'X-Secret') === 0) { $client_secret = $v; break; }
    }
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($client_secret === '' && $method === 'GET' && isset($_GET['secret'])) {
    $client_secret = $_GET['secret'];
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (!hash_equals($SECRET_KEY, (string) $client_secret)) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized - Invalid Secret Key']);
    exit;
}

if ($method === 'GET') {
    $raw = @file_get_contents($FILE_NAME);
    echo ($raw === false || $raw === '') ? '[]' : $raw;
    exit;
}

if ($method === 'POST') {
    $json_data = file_get_contents('php://input');
    $decoded   = json_decode($json_data, true);

    if (json_last_error() !== JSON_ERROR_NONE || !is_array($decoded)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON payload (expected an array)']);
        exit;
    }

    $pretty = json_encode($decoded, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $tmp    = $FILE_NAME . '.' . getmypid() . '.tmp';

    if (@file_put_contents($tmp, $pretty, LOCK_EX) === false || !@rename($tmp, $FILE_NAME)) {
        @unlink($tmp);
        http_response_code(500);
        echo json_encode(['error' => 'Failed to persist configuration']);
        exit;
    }

    echo json_encode(['success' => true, 'count' => count($decoded)]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
