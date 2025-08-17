/*
 * XIAO ESP32S3 Camera Live Streaming Test
 * 
 * This firmware creates a WiFi web server that streams live camera feed
 * Access via: http://[ESP32-IP-ADDRESS]
 * Purpose: Test camera hardware independently from BLE functionality
 */

#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_task_wdt.h"

// ===========================
// WiFi Configuration
// ===========================
const char* ssid = "OpenGlass";        // Replace with your WiFi name
const char* password = "table1234"; // Replace with your WiFi password

// ===========================
// Camera Pin Configuration for XIAO ESP32S3
// ===========================
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     10
#define SIOD_GPIO_NUM     40
#define SIOC_GPIO_NUM     39
#define Y9_GPIO_NUM       48
#define Y8_GPIO_NUM       11
#define Y7_GPIO_NUM       12
#define Y6_GPIO_NUM       14
#define Y5_GPIO_NUM       16
#define Y4_GPIO_NUM       18
#define Y3_GPIO_NUM       17
#define Y2_GPIO_NUM       15
#define VSYNC_GPIO_NUM    38
#define HREF_GPIO_NUM     47
#define PCLK_GPIO_NUM     13

// ===========================
// Web Server
// ===========================
WebServer server(80);

// ===========================
// HTML Web Interface
// ===========================
const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
    <title>XIAO ESP32S3 Camera Test</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f0f0f0;
            text-align: center;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
        }
        #photo-display {
            width: 100%;
            max-width: 640px;
            height: auto;
            border: 2px solid #ddd;
            border-radius: 8px;
            margin: 20px auto;
            display: block;
            min-height: 50px; /* Placeholder space */
            background: #eee;
        }
        .info {
            background: #e8f5e8;
            border: 1px solid #4CAF50;
            border-radius: 5px;
            padding: 15px;
            margin: 20px 0;
            text-align: left;
        }
        .button {
            background-color: #4CAF50;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            margin: 10px;
        }
        .button:hover {
            background-color: #45a049;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📸 XIAO ESP32S3 Camera Capture</h1>
        <p class="subtitle">Click the button to capture a new photo from the camera</p>
        
        <button class="button" onclick="takePhoto()">Take Photo</button>
        <button class="button" onclick="downloadTestImage()">Download Photo</button>
        
        <img id="photo-display" alt="Captured photo will appear here">
        
        <div class="info">
            <strong>📊 Camera Info:</strong><br>
            • Resolution: VGA (640x480)<br>
            • Format: JPEG<br>
            • Quality: High (10/63)<br>
            • Frame Buffer: PSRAM (with Double Buffering)<br>
            • Sensor: OV2640
        </div>
    </div>

    <script>
        function takePhoto() {
            const img = document.getElementById('photo-display');
            // Add a timestamp to prevent browser caching and get a fresh image
            img.src = "/capture?t=" + new Date().getTime();
        }

        function downloadTestImage() {
            const link = document.createElement('a');
            link.href = '/capture';
            link.download = 'xiao_esp32s3_test_image.jpg';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    </script>
</body>
</html>
)rawliteral";

// ===========================
// Camera Initialization
// ===========================
// Tunable camera parameters for experimentation
#define CAM_XCLK_FREQ 14000000      // Slightly lower than 16MHz for stability
#define CAM_FRAME_SIZE FRAMESIZE_VGA // VGA (640x480) 
#define CAM_JPEG_QUALITY 12          // Moderate quality for reliability

void initCamera() {
    Serial.println("🎥 Starting camera initialization...");
    Serial.println("📊 Free heap before config: " + String(ESP.getFreeHeap()));
    
    camera_config_t config;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer = LEDC_TIMER_0;
    config.pin_d0 = Y2_GPIO_NUM;
    config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM;
    config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM;
    config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM;
    config.pin_d7 = Y9_GPIO_NUM;
    config.pin_xclk = XCLK_GPIO_NUM;
    config.pin_pclk = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;  // Updated to new naming
    config.pin_sccb_scl = SIOC_GPIO_NUM;  // Updated to new naming
    config.pin_pwdn = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;
    config.xclk_freq_hz = CAM_XCLK_FREQ; // lowered to ease signal integrity
    config.pixel_format = PIXFORMAT_JPEG;
    
    Serial.println("📊 Free heap after config setup: " + String(ESP.getFreeHeap()));
    
    // Conservative settings for maximum stability
    config.frame_size = CAM_FRAME_SIZE;    // VGA resolution (640x480)
    config.jpeg_quality = CAM_JPEG_QUALITY;             // Higher quality
    config.fb_count = 2;                  // Restore double buffering now that corruption is fixed
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

    Serial.println("🎥 Attempting camera initialization...");
    
    // Initialize camera
    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        Serial.printf("❌ Camera init failed with error 0x%x\n", err);
        Serial.println("💡 Camera hardware may not be connected properly");
        return;
    }
    Serial.println("✅ Camera initialized successfully!");
    Serial.println("📊 Free heap after camera init: " + String(ESP.getFreeHeap()));

    // Get camera sensor for additional settings
    sensor_t* s = esp_camera_sensor_get();
    if (s != NULL) {
        Serial.println("🔧 Applying camera settings...");
        // Conservative settings to ensure frame capture works
        s->set_brightness(s, 0);     // -2 to 2
        s->set_contrast(s, 0);       // Keep neutral
        s->set_saturation(s, 0);     // -2 to 2
        s->set_whitebal(s, 1);       // Auto white balance
        s->set_awb_gain(s, 1);       // Auto white balance gain
        s->set_exposure_ctrl(s, 1);  // Auto exposure
        s->set_gain_ctrl(s, 1);      // Auto gain
        s->set_lenc(s, 1);           // Lens correction
        s->set_wpc(s, 1);            // White pixel correction
        s->set_bpc(s, 0);            // Disable black pixel correction for stability
        
        // Re-enable image flip
        s->set_vflip(s, 1);
        s->set_hmirror(s, 1);
        
        Serial.println("✅ Camera settings applied successfully");
    } else {
        Serial.println("⚠️ Could not get camera sensor handle");
    }
    
    // Discard a couple of initial frames and add longer warm-up delay
    Serial.println("🧪 Performing camera warm-up...");
    delay(1000); // Give camera more time to stabilize
    
    for(int i=0;i<3;i++) { // Increase to 3 warm-up frames
        camera_fb_t *warm = esp_camera_fb_get();
        if(warm) {
            Serial.printf("🧪 Discarding warm-up frame %d (len=%u)\n", i+1, warm->len);
            esp_camera_fb_return(warm);
        } else {
            Serial.printf("⚠️ Warm-up frame %d failed to capture\n", i+1);
        }
        delay(100); // Longer delay between warm-up frames
    }

    Serial.println("📊 Final free heap: " + String(ESP.getFreeHeap()));
}

// ===========================
// WiFi Initialization
// ===========================
void initWiFi() {
    Serial.println("📡 Starting WiFi initialization...");
    Serial.println("🏷️ SSID: " + String(ssid));
    Serial.println("📡 Password length: " + String(strlen(password)));
    
    // Set WiFi mode and disable power saving
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false); // Disable WiFi sleep mode
    
    // Single connection attempt with shorter timeout
    Serial.println("📡 Starting WiFi connection...");
    WiFi.begin(ssid, password);
    
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 15) { // Reduced to 15 attempts
        delay(500);
        Serial.print(".");
        Serial.print(" Status: " + String(WiFi.status()));
        attempts++;
        
        // Break early if we get a definitive failure
        if (WiFi.status() == WL_CONNECT_FAILED || WiFi.status() == WL_NO_SSID_AVAIL) {
            Serial.println("\n❌ WiFi connection failed early - bad credentials or no SSID");
            break;
        }
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println();
        Serial.println("✅ WiFi connected successfully!");
        Serial.print("📍 IP address: ");
        Serial.println(WiFi.localIP());
        Serial.print("🌐 Access camera at: http://");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println();
        Serial.println("❌ WiFi connection failed!");
        Serial.println("💡 Please check your WiFi credentials in the code");
        Serial.println("💡 Final WiFi status: " + String(WiFi.status()));
    }
}

// ===========================
// Capture Handler (Single Image)
// ===========================
void handleCapture() {
    Serial.println("📸 Capture request received");
    
    camera_fb_t *fb = nullptr;
    const int maxAttempts = 5; // Increase attempts
    for(int attempt=1; attempt<=maxAttempts; attempt++) {
        // Add small delay before each capture attempt
        if(attempt > 1) delay(200);
        
        fb = esp_camera_fb_get();
        if(!fb) {
            Serial.printf("❌ Capture attempt %d failed: fb NULL\n", attempt);
        } else if(fb->len < 1000) { // Arbitrary sanity threshold for JPEG size
            Serial.printf("⚠️ Capture attempt %d produced unusually small frame (%u bytes), retrying...\n", attempt, fb->len);
            esp_camera_fb_return(fb);
            fb = nullptr;
        } else {
            // Looks good
            Serial.printf("📸 Capture success on attempt %d: %u bytes, %dx%d, format=%d\n", attempt, fb->len, fb->width, fb->height, fb->format);
            break;
        }
    }

    if(!fb) {
        Serial.println("❌ All capture attempts failed, sending error response");
        server.send(500, "text/plain", "Camera capture failed after retries");
        return;
    }

    server.sendHeader("Content-Disposition", "inline; filename=capture.jpg");
    server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    server.sendHeader("Pragma", "no-cache");
    server.sendHeader("Expires", "-1");
    server.send_P(200, "image/jpeg", (const char*)fb->buf, fb->len);

    esp_camera_fb_return(fb);
    Serial.println("✅ Capture completed and sent");
}

// ===========================
// Setup
// ===========================
void setup() {
    Serial.begin(115200);
    delay(2000);
    
    // Properly disable task watchdog
    disableCore0WDT();
    disableCore1WDT();
    
    Serial.println("========================================");
    Serial.println("🎥 XIAO ESP32S3 Camera Streaming Test");
    Serial.println("========================================");
    Serial.println("🔥 ESP32 is booting...");
    Serial.println("📊 Free heap: " + String(ESP.getFreeHeap()));
    Serial.println("📊 PSRAM size: " + String(ESP.getPsramSize()));
    
    // Initialize WiFi first (safer)
    Serial.println("🚀 Starting WiFi initialization...");
    initWiFi();
    
    // Only initialize camera if WiFi works
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("✅ WiFi connected successfully!");
        Serial.println("⏳ Waiting 3 seconds for WiFi to stabilize before starting camera...");
        delay(3000); // Give WiFi time to stabilize to prevent power brownout

        Serial.println("🎥 Now initializing camera...");
        Serial.println("📊 Free heap before camera: " + String(ESP.getFreeHeap()));
        
        initCamera();
        
        Serial.println("📊 Free heap after camera: " + String(ESP.getFreeHeap()));
        
        // Setup web server routes (synchronous server)
        server.on("/", [](){
            server.send_P(200, "text/html", index_html);
        });
        
        server.on("/capture", handleCapture);
        
        // Start server
        server.begin();
        Serial.println("✅ Web server started");
        Serial.println("========================================");
        Serial.printf("🌐 Open browser and go to: http://%s\n", WiFi.localIP().toString().c_str());
        Serial.println("========================================");
    } else {
        Serial.println("❌ WiFi failed, skipping camera init");
        Serial.println("💡 Check WiFi credentials: " + String(ssid));
        Serial.println("💡 WiFi status: " + String(WiFi.status()));
    }
    
    Serial.println("✅ Setup completed successfully!");
}

// ===========================
// Main Loop
// ===========================
void loop() {
    // Handle web server requests
    server.handleClient();
    
    // Keep WiFi alive with backoff
    static unsigned long lastReconnectAttempt = 0;
    static int reconnectAttempts = 0;
    
    if (WiFi.status() != WL_CONNECTED) {
        // Only try to reconnect every 5 seconds to avoid spam
        if (millis() - lastReconnectAttempt > 5000) {
            reconnectAttempts++;
            Serial.printf("📡 WiFi disconnected, reconnect attempt %d...\n", reconnectAttempts);
            
            // If too many failed attempts, restart the ESP
            if (reconnectAttempts > 10) {
                Serial.println("❌ Too many reconnect failures, restarting ESP...");
                ESP.restart();
            }
            
            WiFi.reconnect();
            lastReconnectAttempt = millis();
        }
    } else {
        // Reset counter on successful connection
        if (reconnectAttempts > 0) {
            Serial.println("✅ WiFi reconnected successfully!");
            reconnectAttempts = 0;
        }
    }
    
    // Show status every 30 seconds
    static unsigned long lastStatus = 0;
    if (millis() - lastStatus > 30000) {
        lastStatus = millis();
        Serial.println("📊 Status: WiFi=" + String(WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected") + 
                      ", Free heap=" + String(ESP.getFreeHeap()) + " bytes");
        if (WiFi.status() == WL_CONNECTED) {
            Serial.println("🌐 Camera URL: http://" + WiFi.localIP().toString());
        }
    }
    
    delay(10); // Small delay to prevent tight loop
}
