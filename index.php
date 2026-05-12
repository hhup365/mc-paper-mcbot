<?php
$FILE_NAME = 'config.json';
$SECRET_KEY = 'admin'; 

if (!file_exists('.htaccess')) {
    $htaccess_content = "<Files \"{$FILE_NAME}\">\n    Require all denied\n</Files>";
    file_put_contents('.htaccess', $htaccess_content);
}

if (!file_exists($FILE_NAME)) {
    file_put_contents($FILE_NAME, "[]");
}

$headers = getallheaders();
$client_secret = isset($headers['X-Secret']) ? $headers['X-Secret'] : (isset($_SERVER['HTTP_X_SECRET']) ? $_SERVER['HTTP_X_SECRET'] : '');

if ($client_secret !== $SECRET_KEY) {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET' || !isset($_GET['secret']) || $_GET['secret'] !== $SECRET_KEY) {
        header("HTTP/1.1 401 Unauthorized");
        echo json_encode(['error' => 'Unauthorized - Invalid Secret Key']);
        exit;
    }
}

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo file_get_contents($FILE_NAME);
    
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $json_data = file_get_contents('php://input');
    
    json_decode($json_data);
    if (json_last_error() === JSON_ERROR_NONE) {
        file_put_contents($FILE_NAME, $json_data);
        echo json_encode(['success' => true]);
    } else {
        header("HTTP/1.1 400 Bad Request");
        echo json_encode(['error' => 'Invalid JSON payload']);
    }
    
} else {
    header("HTTP/1.1 405 Method Not Allowed");
    echo json_encode(['error' => 'Method not allowed']);
}
