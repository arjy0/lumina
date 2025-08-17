/*
 * XIAO ESP32S3 Microphone Test
 * 
 * This firmware tests the onboard INMP441 MEMS microphone
 * Features:
 * - I2S audio capture
 * - Real-time audio level monitoring
 * - Web interface to view audio levels
 * - Optional audio recording/playback
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <driver/i2s.h>
#include <esp_task_wdt.h>

// ===========================
// WiFi Configuration
// ===========================
const char* ssid = "OpenGlass";
const char* password = "table1234";

// ===========================
// I2S Microphone Configuration for XIAO ESP32S3 Sense
// ===========================
// CORRECT pin configuration for XIAO ESP32S3 Sense built-in microphone
// Based on official Seeed Studio examples and GitHub repositories
// The built-in microphone uses PDM (Pulse Density Modulation) mode, NOT standard I2S

// CONFIRMED working pins from official examples:
#define I2S_WS 42     // Word Select (LRCLK) - GPIO42
#define I2S_SD 41     // Serial Data (DIN) - GPIO41  
#define I2S_SCK -1    // Serial Clock NOT USED in PDM mode

// I2S configuration - CRITICAL: Use PDM mode for XIAO ESP32S3 Sense
#define I2S_PORT I2S_NUM_0
#define I2S_SAMPLE_RATE 16000
#define I2S_SAMPLE_BITS 16
#define I2S_CHANNEL_NUM 1
#define I2S_READ_LEN (512)  // Reduced buffer size for stability

// Global flag to track I2S status
bool i2s_initialized = false;

// ===========================
// Web Server
// ===========================
WebServer server(80);

// ===========================
// Audio Variables
// ===========================
int16_t i2s_read_buff[I2S_READ_LEN];  // Changed to 16-bit for PDM mode
float audio_level = 0.0;
float max_audio_level = 0.0;
unsigned long last_audio_update = 0;

// ===========================
// HTML Web Interface
// ===========================
const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
    <title>XIAO ESP32S3 Microphone Test</title>
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
        .audio-meter {
            width: 100%;
            height: 40px;
            background-color: #ddd;
            border-radius: 20px;
            margin: 20px 0;
            position: relative;
            overflow: hidden;
        }
        .audio-level {
            height: 100%;
            background: linear-gradient(to right, #4CAF50, #FFC107, #F44336);
            border-radius: 20px;
            width: 0%;
            transition: width 0.1s ease;
        }
        .audio-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-weight: bold;
            color: #333;
        }
        .info {
            background: #e8f5e8;
            border: 1px solid #4CAF50;
            border-radius: 5px;
            padding: 15px;
            margin: 20px 0;
            text-align: left;
        }
        .status {
            font-size: 18px;
            margin: 10px 0;
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
        <h1>🎤 XIAO ESP32S3 Microphone Test</h1>
        <p class="subtitle">Real-time audio level monitoring from onboard MEMS microphone</p>
        
        <div class="status">
            <strong>Audio Level:</strong> <span id="audio-level">0</span>%
        </div>
        
        <div class="audio-meter">
            <div class="audio-level" id="level-bar"></div>
            <div class="audio-text" id="level-text">0%</div>
        </div>
        
        <div class="status">
            <strong>Peak Level:</strong> <span id="peak-level">0</span>%
        </div>
        
        <button class="button" onclick="startMonitoring()">Start Monitoring</button>
        <button class="button" onclick="stopMonitoring()">Stop Monitoring</button>
        <button class="button" onclick="resetPeak()">Reset Peak</button>
        
        <div class="info">
            <strong>🎤 Microphone Info:</strong><br>
            • Type: INMP441 MEMS Microphone<br>
            • Sample Rate: 16kHz<br>
            • Bit Depth: 16-bit<br>
            • Interface: I2S<br>
            • Channel: Mono
        </div>
    </div>

    <script>
        let monitoring = false;
        let updateInterval;

        function updateAudioLevels() {
            if (!monitoring) return;
            
            fetch('/audio_level')
                .then(response => response.json())
                .then(data => {
                    const level = Math.min(100, Math.max(0, data.level));
                    const peak = Math.min(100, Math.max(0, data.peak));
                    
                    document.getElementById('audio-level').textContent = level.toFixed(1);
                    document.getElementById('peak-level').textContent = peak.toFixed(1);
                    document.getElementById('level-bar').style.width = level + '%';
                    document.getElementById('level-text').textContent = level.toFixed(1) + '%';
                })
                .catch(error => console.error('Error:', error));
        }

        function startMonitoring() {
            monitoring = true;
            updateInterval = setInterval(updateAudioLevels, 100); // Update every 100ms
        }

        function stopMonitoring() {
            monitoring = false;
            clearInterval(updateInterval);
        }

        function resetPeak() {
            fetch('/reset_peak', {method: 'POST'});
        }

        // Auto-start monitoring
        startMonitoring();
    </script>
</body>
</html>
)rawliteral";

// ===========================
// I2S Microphone Initialization
// ===========================
bool tryI2SConfiguration(int sck, int ws, int sd, const char* config_name) {
    Serial.printf("🔧 Trying %s: SCK=%d, WS=%d, SD=%d\n", config_name, sck, ws, sd);
    
    // Stop any existing I2S instance
    i2s_driver_uninstall(I2S_PORT);
    delay(100);
    
    // I2S configuration for XIAO ESP32S3 Sense built-in microphone (PDM mode)
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM),  // Add PDM mode
        .sample_rate = I2S_SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,      // Use 16-bit for PDM
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,       // Mono microphone
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 4,
        .dma_buf_len = 1024,
        .use_apll = false,                                  // APLL not needed for PDM
        .tx_desc_auto_clear = false,
        .fixed_mclk = 0
    };

    // I2S pin configuration for PDM mode
    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_PIN_NO_CHANGE,    // BCK not used in PDM mode
        .ws_io_num = ws,                     // Clock pin for PDM
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = sd                    // Data pin for PDM
    };

    // Install I2S driver
    esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
    if (err != ESP_OK) {
        Serial.printf("❌ %s: I2S driver install failed: %s\n", config_name, esp_err_to_name(err));
        return false;
    }

    // Set pins
    err = i2s_set_pin(I2S_PORT, &pin_config);
    if (err != ESP_OK) {
        Serial.printf("❌ %s: I2S pin config failed: %s\n", config_name, esp_err_to_name(err));
        i2s_driver_uninstall(I2S_PORT);
        return false;
    }

    // Clear buffer and stabilize
    i2s_zero_dma_buffer(I2S_PORT);
    delay(200);
    
    // Test read with correct buffer type
    int16_t test_buffer[64];
    size_t bytes_read = 0;
    esp_err_t test_result = i2s_read(I2S_PORT, test_buffer, sizeof(test_buffer), &bytes_read, 1000);
    
    if (test_result == ESP_OK && bytes_read > 0) {
        // Check if we're getting varying data (not all the same value)
        bool has_variation = false;
        int16_t first_sample = test_buffer[0];
        for (int i = 1; i < 16 && i < (bytes_read/sizeof(int16_t)); i++) {
            if (abs(test_buffer[i] - first_sample) > 10) {  // Some variation threshold
                has_variation = true;
                break;
            }
        }
        
        Serial.printf("✅ %s: Got %d bytes, samples: %d\n", config_name, bytes_read, bytes_read/sizeof(int16_t));
        Serial.printf("🔍 Sample data: 0x%04X 0x%04X 0x%04X 0x%04X\n", 
                     test_buffer[0], test_buffer[1], test_buffer[2], test_buffer[3]);
        Serial.printf("🔍 Has variation: %s\n", has_variation ? "YES" : "NO (may be DC offset issue)");
        return true;
    } else {
        Serial.printf("❌ %s: Read test failed: %s (bytes: %d)\n", config_name, esp_err_to_name(test_result), bytes_read);
    }
    
    return false;
}

void initI2S() {
    Serial.println("🎤 Starting I2S microphone initialization...");
    Serial.println("🔍 Using XIAO ESP32S3 Sense built-in microphone (PDM mode)");
    
    // Use only the correct configuration for XIAO ESP32S3 Sense
    if (tryI2SConfiguration(I2S_SCK, I2S_WS, I2S_SD, "XIAO ESP32S3 Sense Built-in PDM Microphone")) {
        i2s_initialized = true;
        Serial.println("✅ I2S microphone initialized successfully!");
        Serial.printf("📊 Sample rate: %d Hz\n", I2S_SAMPLE_RATE);
        Serial.printf("📊 Bits per sample: 16-bit (PDM mode)\n");
        Serial.printf("📊 Channels: %d\n", I2S_CHANNEL_NUM);
        return;
    }
    
    Serial.println("❌ Failed to initialize I2S microphone");
    Serial.println("💡 Check if the XIAO ESP32S3 Sense board is correctly connected");
    i2s_initialized = false;
}

// ===========================
// Audio Level Calculation
// ===========================
void updateAudioLevel() {
    if (!i2s_initialized) {
        return;
    }
    size_t bytes_read = 0;
    esp_err_t result = i2s_read(I2S_PORT, i2s_read_buff, I2S_READ_LEN * sizeof(int16_t), &bytes_read, 50);

    if (result == ESP_OK && bytes_read > 0) {
        int samples_read = bytes_read / sizeof(int16_t);

        // Periodic raw sample debug
        static unsigned long last_debug = 0;
        if (millis() - last_debug > 5000) {
            Serial.printf("🔍 DEBUG - Bytes read: %d, Samples: %d\n", bytes_read, samples_read);
            Serial.printf("🔍 Raw samples (first 5): ");
            for (int i = 0; i < min(5, samples_read); i++) {
                Serial.printf("0x%04X ", (uint16_t)i2s_read_buff[i]);
            }
            Serial.println();
            last_debug = millis();
        }

        // DC offset
        float dc_offset = 0.0f;
        for (int i = 0; i < samples_read; i++) dc_offset += (float)i2s_read_buff[i];
        dc_offset /= samples_read;

        // AC metrics
        float sum_squares = 0;
        int16_t max_sample = -32768;
        int16_t min_sample = 32767;
        int valid_samples = 0;
        for (int i = 0; i < samples_read; i++) {
            float ac_sample = (float)i2s_read_buff[i] - dc_offset;
            int16_t processed_sample = (int16_t)(ac_sample * 8.0f); // gain
            if (abs(processed_sample) > 100) { // noise gate
                sum_squares += (float)processed_sample * processed_sample;
                if (processed_sample > max_sample) max_sample = processed_sample;
                if (processed_sample < min_sample) min_sample = processed_sample;
                valid_samples++;
            }
        }

        audio_level = (valid_samples > 0)
            ? (sqrt(sum_squares / valid_samples) / 32768.0f) * 100.0f
            : 0.0f;
        if (audio_level > max_audio_level) max_audio_level = audio_level;

        if (millis() - last_audio_update > 1000) {
            Serial.printf("🎤 Audio Level: %.1f%% | Peak: %.1f%% | Samples: %d | Valid: %d\n",
                          audio_level, max_audio_level, samples_read, valid_samples);
            Serial.printf("🔍 DC Offset: %.0f | AC Range: %d to %d\n", dc_offset, min_sample, max_sample);
            last_audio_update = millis();
        }
    } else if (result != ESP_OK) {
        if (millis() - last_audio_update > 3000) {
            Serial.printf("⚠️ I2S read error: %s (bytes_read: %d)\n", esp_err_to_name(result), bytes_read);
            last_audio_update = millis();
        }
    } else { // result OK but bytes_read == 0
        if (millis() - last_audio_update > 3000) {
            Serial.printf("⚠️ No data read from I2S (result: %s)\n", esp_err_to_name(result));
            last_audio_update = millis();
        }
    }
}

// ===========================
// WiFi Initialization
// ===========================
void initWiFi() {
    Serial.println("📡 Starting WiFi initialization...");
    Serial.println("🏷️ SSID: " + String(ssid));
    
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    
    WiFi.begin(ssid, password);
    
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
        delay(500);
        Serial.print(".");
        attempts++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println();
        Serial.println("✅ WiFi connected successfully!");
        Serial.print("📍 IP address: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println();
        Serial.println("❌ WiFi connection failed!");
    }
}

// ===========================
// Web Server Handlers
// ===========================
void handleRoot() {
    server.send_P(200, "text/html", index_html);
}

void handleAudioLevel() {
    String json = "{";
    json += "\"level\":" + String(audio_level, 1) + ",";
    json += "\"peak\":" + String(max_audio_level, 1);
    json += "}";
    
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

void handleResetPeak() {
    max_audio_level = 0.0;
    server.send(200, "text/plain", "Peak reset");
    Serial.println("🔄 Peak audio level reset");
}

// ===========================
// Setup
// ===========================
void setup() {
    Serial.begin(115200);
    delay(2000);
    
    // Disable watchdogs
    disableCore0WDT();
    disableCore1WDT();
    
    Serial.println("========================================");
    Serial.println("🎤 XIAO ESP32S3 Microphone Test");
    Serial.println("========================================");
    Serial.println("🔥 ESP32 is booting...");
    Serial.println("📊 Free heap: " + String(ESP.getFreeHeap()));
    
    // Initialize I2S microphone first (before WiFi to test independently)
    initI2S();
    
    // Initialize WiFi
    initWiFi();
    
    if (WiFi.status() == WL_CONNECTED) {
        // Setup web server routes
        server.on("/", handleRoot);
        server.on("/audio_level", handleAudioLevel);
        server.on("/reset_peak", HTTP_POST, handleResetPeak);
        
        // Start server
        server.begin();
        Serial.println("✅ Web server started");
        Serial.println("========================================");
        Serial.printf("🌐 Open browser and go to: http://%s\n", WiFi.localIP().toString().c_str());
        Serial.println("========================================");
    } else {
        Serial.println("❌ WiFi failed, but microphone test will continue via serial");
        Serial.println("💡 You can still see audio levels in the serial monitor");
    }
    
    Serial.println("✅ Setup completed successfully!");
    if (i2s_initialized) {
        Serial.println("🎤 Speak into the microphone to see audio levels...");
    } else {
        Serial.println("❌ I2S microphone failed to initialize");
    }
}

// ===========================
// Main Loop
// ===========================
void loop() {
    // Handle web server requests
    server.handleClient();
    
    // Update audio level continuously
    updateAudioLevel();
    
    // Keep WiFi alive
    static unsigned long lastWiFiCheck = 0;
    if (millis() - lastWiFiCheck > 10000) { // Check every 10 seconds
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("📡 WiFi disconnected, reconnecting...");
            WiFi.reconnect();
        }
        lastWiFiCheck = millis();
    }
    
    delay(1); // Small delay
}
