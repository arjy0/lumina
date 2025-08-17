#include "app.h"
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include "esp_camera.h"
#include "esp_sleep.h"
#include "config.h"  // Use config.h for all configurations
#include <driver/i2s.h>  // Add I2S support for microphone

// Battery state
float batteryVoltage = 0.0f;
int batteryPercentage = 0;
unsigned long lastBatteryCheck = 0;

// Device power state
bool deviceActive = true;
device_state_t deviceState = DEVICE_BOOTING;

// Button and LED state
volatile bool buttonPressed = false;
unsigned long buttonPressTime = 0;
led_status_t ledMode = LED_BOOT_SEQUENCE;

// Touch sensor state
touch_state_t touchState = TOUCH_IDLE;
unsigned long lastTouchTime = 0;
unsigned long touchRecordingStartTime = 0;
unsigned long lastSpeechTime = 0;          // Last time we detected speech during touch recording
unsigned long silenceStartTime = 0;       // When current silence period started
bool touchActivationMode = true;  // Always enabled for hardware-only operation

// Gentle power optimization
unsigned long lastActivity = 0;
bool powerSaveMode = false;

// Light sleep optimization - saves ~15mA = adds 3-4 hours battery life
bool lightSleepEnabled = true;

// Camera state
camera_fb_t *fb = nullptr;
bool cameraInitialized = false;

// Microphone state and configuration
#define I2S_WS MICROPHONE_WS_PIN       // Word Select (LRCLK) - GPIO42 (from config.h)
#define I2S_SD MICROPHONE_SD_PIN       // Serial Data (DIN) - GPIO41 (from config.h)
#define I2S_SCK -1                     // Serial Clock NOT USED in PDM mode
#define I2S_PORT MICROPHONE_I2S_PORT   // MUST use I2S_NUM_0 - PDM only works on I2S0
#define I2S_SAMPLE_RATE MICROPHONE_SAMPLE_RATE
#define I2S_SAMPLE_BITS MICROPHONE_BITS_PER_SAMPLE
#define I2S_CHANNEL_NUM 1
#define I2S_READ_LEN MICROPHONE_BUFFER_SIZE    // Buffer size for audio capture (from config.h)
#define AUDIO_BUFFER_SIZE (2048)               // Buffer for BLE transmission
#define TOUCH_AUDIO_MAX_BYTES (192000)         // Max ~6s @16kHz mono 16-bit (16000*2*6=192000) for longer speech

bool microphoneInitialized = false;
bool voiceActivationEnabled = false;
bool listeningForWakeWord = false;
bool recordingCommand = false;
float currentAudioLevel = 0.0f;
float peakAudioLevel = 0.0f;
float previousSample = 0.0f;  // For high-pass filter
unsigned long lastMicrophoneActivity = 0;

// Audio buffers
int16_t audioBuffer[I2S_READ_LEN];
uint8_t bleAudioBuffer[AUDIO_BUFFER_SIZE];
static uint8_t touchAudioAccum[TOUCH_AUDIO_MAX_BYTES];
static size_t touchAudioAccumIndex = 0;
size_t audioBufferIndex = 0;

// Function declarations for enhanced wake word detection
bool configureMicrophone();
void processAudio();
bool detectWakeWord(int16_t* samples, size_t sampleCount);
bool detectSpeechActivity(int16_t* samples, size_t sampleCount);
float getDominantFrequency(int16_t* samples, size_t sampleCount);
bool isLuminaPattern(float* freqHistory, int historyLen);

// Touch sensor functions
void initializeTouchSensor();
void handleTouchSensor();
bool isTouchDetected();

// BLE state
BLEServer *pServer = nullptr;
BLEService *pService = nullptr;

// Device Information Service UUIDs  
#define DEVICE_INFORMATION_SERVICE_UUID (uint16_t)0x180A
#define MANUFACTURER_NAME_STRING_CHAR_UUID (uint16_t)0x2A29
#define MODEL_NUMBER_STRING_CHAR_UUID (uint16_t)0x2A24
#define FIRMWARE_REVISION_STRING_CHAR_UUID (uint16_t)0x2A26
#define HARDWARE_REVISION_STRING_CHAR_UUID (uint16_t)0x2A27

// Main Friend Service - using config.h UUIDs
static BLEUUID serviceUUID(OMI_SERVICE_UUID);
static BLEUUID photoDataUUID(PHOTO_DATA_UUID);
static BLEUUID photoControlUUID(PHOTO_CONTROL_UUID);

// Audio service UUIDs - from config.h
static BLEUUID audioDataUUID(AUDIO_DATA_UUID);
static BLEUUID audioControlUUID(AUDIO_CONTROL_UUID);


// Characteristics
BLECharacteristic *photoDataCharacteristic;
BLECharacteristic *photoControlCharacteristic;
BLECharacteristic *batteryLevelCharacteristic;
BLECharacteristic *audioDataCharacteristic;
BLECharacteristic *audioControlCharacteristic;

// State
bool connected = false;
bool isCapturingPhotos = false;
int captureInterval = 0;         // Interval in ms
unsigned long lastCaptureTime = 0;

size_t sent_photo_bytes = 0;
size_t sent_photo_frames = 0;
bool photoDataUploading = false;

// Forward declarations
void handlePhotoControl(int8_t controlValue);
void handleAudioControl(int8_t controlValue);
void readBatteryLevel();
void updateBatteryService();
void IRAM_ATTR buttonISR();
void handleButton();
void updateLED();
void blinkLED(int count, int delayMs);
void enterPowerSave();
void exitPowerSave();
void shutdownDevice();
void enableLightSleep();
void processAudio();
void startVoiceActivation();
void stopVoiceActivation();
void startRecordingCommand();
void sendAudioData(uint8_t* audioData, size_t length);

// -------------------------------------------------------------------------
// BLE Callback Classes (Forward Declarations)
// -------------------------------------------------------------------------
class ServerCallbacks: public BLEServerCallbacks {
public:
  void onConnect(BLEServer* pServer);
  void onDisconnect(BLEServer* pServer);
};

class PhotoControlCallbacks: public BLECharacteristicCallbacks {
public:
  void onWrite(BLECharacteristic *pCharacteristic);
};

class AudioControlCallbacks: public BLECharacteristicCallbacks {
public:
  void onWrite(BLECharacteristic *pCharacteristic);
};

// -------------------------------------------------------------------------
// Button ISR
// -------------------------------------------------------------------------
void IRAM_ATTR buttonISR() {
  buttonPressed = true;
}

// -------------------------------------------------------------------------
// LED Functions
// -------------------------------------------------------------------------
void updateLED() {
  unsigned long now = millis();
  static unsigned long bootStartTime = 0;
  static unsigned long powerOffStartTime = 0;
  
  switch (ledMode) {
    case LED_BOOT_SEQUENCE:
      if (bootStartTime == 0) bootStartTime = now;
      
      // 5 quick blinks over 1.5 seconds total (inverted logic: HIGH=OFF, LOW=ON)
      if (now - bootStartTime < 1500) {
        int blinkPhase = ((now - bootStartTime) / 150) % 2;
        digitalWrite(STATUS_LED_PIN, !blinkPhase);
      } else {
        digitalWrite(STATUS_LED_PIN, HIGH); // OFF
        ledMode = LED_NORMAL_OPERATION;
        bootStartTime = 0;
      }
      break;
      
    case LED_POWER_OFF_SEQUENCE:
      if (powerOffStartTime == 0) powerOffStartTime = now;
      
      // 2 quick blinks over 800ms total (inverted logic: HIGH=OFF, LOW=ON)
      if (now - powerOffStartTime < 800) {
        int blinkPhase = ((now - powerOffStartTime) / 200) % 2;
        digitalWrite(STATUS_LED_PIN, !blinkPhase);
      } else {
        digitalWrite(STATUS_LED_PIN, HIGH); // OFF
        delay(100);
        shutdownDevice();
      }
      break;
      
    case LED_NORMAL_OPERATION:
    default:
      digitalWrite(STATUS_LED_PIN, HIGH); // OFF
      break;
  }
}

void blinkLED(int count, int delayMs) {
  for (int i = 0; i < count; i++) {
    digitalWrite(STATUS_LED_PIN, HIGH);
    delay(delayMs);
    digitalWrite(STATUS_LED_PIN, LOW);
    delay(delayMs);
  }
}

// -------------------------------------------------------------------------
// Button Handling
// -------------------------------------------------------------------------
void handleButton() {
  if (!buttonPressed) return;
  
  unsigned long now = millis();
  static unsigned long lastButtonTime = 0;
  static bool buttonDown = false;
  
  bool currentButtonState = !digitalRead(POWER_BUTTON_PIN); // Active low (pressed = true)
  
  // Simple debouncing
  if (now - lastButtonTime < 50) {
    buttonPressed = false;
    return;
  }
  
  if (currentButtonState && !buttonDown) {
    // Button just pressed
    buttonPressTime = now;
    buttonDown = true;
    lastButtonTime = now;
    
  } else if (!currentButtonState && buttonDown) {
    // Button just released
    buttonDown = false;
    unsigned long pressDuration = now - buttonPressTime;
    lastButtonTime = now;
    
    if (pressDuration >= 2000) {
      // Long press - power off
      ledMode = LED_POWER_OFF_SEQUENCE;
    } else if (pressDuration >= 50) {
      // Short press - register activity
      lastActivity = now;
      if (powerSaveMode) {
        exitPowerSave();
      }
    }
  }
  
  buttonPressed = false;
}

// -------------------------------------------------------------------------
// Power Management
// -------------------------------------------------------------------------
void enterPowerSave() {
  if (!powerSaveMode) {
    setCpuFrequencyMhz(MIN_CPU_FREQ_MHZ); // 40MHz for idle
    powerSaveMode = true;
  }
}

void exitPowerSave() {
  if (powerSaveMode) {
    setCpuFrequencyMhz(NORMAL_CPU_FREQ_MHZ); // Back to 80MHz
    powerSaveMode = false;
  }
}

void enableLightSleep() {
  if (!lightSleepEnabled || !connected || photoDataUploading) {
    return; // Don't sleep if disabled, not connected, or uploading
  }
  
  unsigned long now = millis();
  
  // Don't sleep if there was recent activity (within 5 seconds)
  if (now - lastActivity < 5000) {
    return;
  }
  
  unsigned long timeUntilNextPhoto = 0;
  
  if (isCapturingPhotos && captureInterval > 0) {
    unsigned long timeSinceLastPhoto = now - lastCaptureTime;
    if (timeSinceLastPhoto < captureInterval) {
      timeUntilNextPhoto = captureInterval - timeSinceLastPhoto;
    }
  }
  
  // Only sleep if we have at least 10 seconds until next photo
  if (timeUntilNextPhoto > 10000) {
    // Configure light sleep to wake on BLE events and timer
    unsigned long sleepTime = timeUntilNextPhoto - 5000;
    if (sleepTime > 15000) sleepTime = 15000; // Max 15 seconds
    esp_sleep_enable_timer_wakeup(sleepTime * 1000); // Wake 5s before photo or max 15s
    esp_light_sleep_start();
    lastActivity = millis(); // Update activity time after wake
  }
}

void shutdownDevice() {
  Serial.println("Shutting down device...");
  
  // Stop photo capture
  isCapturingPhotos = false;
  
  // Disconnect BLE gracefully
  if (connected) {
    Serial.println("Disconnecting BLE...");
  }
  
  // Turn off LED (inverted logic)
  digitalWrite(STATUS_LED_PIN, HIGH);
  
  // Enter deep sleep
  esp_sleep_enable_ext0_wakeup(GPIO_NUM_1, 0); // Wake on button press
  Serial.println("Entering deep sleep...");
  delay(100);
  esp_deep_sleep_start();
}

class ServerHandler : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    connected = true;
    lastActivity = millis(); // Register activity - prevents sleep
    Serial.println(">>> BLE Client connected.");
    // Send current battery level on connect
    updateBatteryService();
  }
  void onDisconnect(BLEServer *server) override {
    connected = false;
    Serial.println("<<< BLE Client disconnected. Restarting advertising.");
    BLEDevice::startAdvertising();
  }
};

class PhotoControlCallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    if (characteristic->getLength() == 1) {
      int8_t received = characteristic->getData()[0];
      Serial.print("PhotoControl received: ");
      Serial.println(received);
      lastActivity = millis(); // Register activity - prevents sleep
      handlePhotoControl(received);
    }
  }
};

// -------------------------------------------------------------------------
// Battery Functions
// -------------------------------------------------------------------------
void readBatteryLevel() {
  // Take multiple ADC readings for stability
  int adcSum = 0;
  for (int i = 0; i < 10; i++) {
    int value = analogRead(BATTERY_ADC_PIN);
    adcSum += value;
    delay(10);
  }
  int adcValue = adcSum / 10;
  
  // ESP32-S3 ADC: 12-bit (0-4095), reference voltage ~3.3V
  float adcVoltage = (adcValue / 4095.0f) * 3.3f;

  // Apply voltage divider ratio to get actual battery voltage
  batteryVoltage = adcVoltage * VOLTAGE_DIVIDER_RATIO;
  
  // Clamp voltage to reasonable range
  if (batteryVoltage > 5.0f) batteryVoltage = 5.0f;
  if (batteryVoltage < 2.5f) batteryVoltage = 2.5f;
  
  // Load-compensated battery calculation (accounts for voltage sag under load)
  float loadCompensatedMax = BATTERY_MAX_VOLTAGE;
  float loadCompensatedMin = BATTERY_MIN_VOLTAGE;
  
  // More accurate percentage calculation for load conditions
  if (batteryVoltage >= loadCompensatedMax) {
    batteryPercentage = 100;
  } else if (batteryVoltage <= loadCompensatedMin) {
    batteryPercentage = 0;
  } else {
    float range = loadCompensatedMax - loadCompensatedMin;
    batteryPercentage = (int)(((batteryVoltage - loadCompensatedMin) / range) * 100.0f);
  }
  
  // Smooth percentage changes to avoid jumpy readings
  static int lastBatteryPercentage = batteryPercentage;
  if (abs(batteryPercentage - lastBatteryPercentage) > 5) {
    batteryPercentage = lastBatteryPercentage + (batteryPercentage > lastBatteryPercentage ? 2 : -2);
  }
  lastBatteryPercentage = batteryPercentage;
  
  // Clamp percentage
  if (batteryPercentage > 100) batteryPercentage = 100;
  if (batteryPercentage < 0) batteryPercentage = 0;
  
  // Battery status with load info
  Serial.print("Battery: ");
  Serial.print(batteryVoltage);
  Serial.print("V (");
  Serial.print(batteryPercentage);
  Serial.print("%) [Load-compensated: ");
  Serial.print(loadCompensatedMin);
  Serial.print("V-");
  Serial.print(loadCompensatedMax);
  Serial.println("V]");
}

void updateBatteryService() {
  if (batteryLevelCharacteristic) {
    uint8_t batteryLevel = (uint8_t)batteryPercentage;
    batteryLevelCharacteristic->setValue(&batteryLevel, 1);
    
    if (connected) {
      batteryLevelCharacteristic->notify();
    }
  }
}

// -------------------------------------------------------------------------
// Camera
// -------------------------------------------------------------------------
bool take_photo() {
  // Release previous buffer
  if (fb) {
    Serial.println("Releasing previous camera buffer...");
    esp_camera_fb_return(fb);
    fb = nullptr;
  }

  Serial.println("Capturing photo...");
  fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Failed to get camera frame buffer!");
    return false;
  }
  Serial.print("Photo captured: ");
  Serial.print(fb->len);
  Serial.println(" bytes.");
  
  lastActivity = millis(); // Register activity
  return true;
}

void handlePhotoControl(int8_t controlValue) {
  if (controlValue == -1) {
    Serial.println("Received command: Single photo.");
    // Reset transmission state for fresh capture
    photoDataUploading = false;
    sent_photo_bytes = 0;
    sent_photo_frames = 0;
    // Free any existing buffer
    if (fb) {
      esp_camera_fb_return(fb);
      fb = nullptr;
    }
    isCapturingPhotos = true;
    captureInterval = 0;
  }
  else if (controlValue == 0) {
    Serial.println("Received command: Stop photo capture.");
    // Reset all transmission state
    isCapturingPhotos = false;
    photoDataUploading = false;
    sent_photo_bytes = 0;
    sent_photo_frames = 0;
    captureInterval = 0;
    // Free any existing buffer
    if (fb) {
      esp_camera_fb_return(fb);
      fb = nullptr;
      Serial.println("Freed existing camera buffer on STOP command.");
    }
  }
  else if (controlValue >= 5 && controlValue <= 300) {
    Serial.print("Received command: Start interval capture with parameter ");
    Serial.println(controlValue);

    // Reset transmission state for fresh capture
    photoDataUploading = false;
    sent_photo_bytes = 0;
    sent_photo_frames = 0;
    // Free any existing buffer
    if (fb) {
      esp_camera_fb_return(fb);
      fb = nullptr;
    }

    // Use fixed interval from config for optimal battery life
    captureInterval = PHOTO_CAPTURE_INTERVAL_MS;
    Serial.print("Using configured interval: ");
    Serial.print(captureInterval / 1000);
    Serial.println(" seconds");

    isCapturingPhotos = true;
    lastCaptureTime = millis() - captureInterval;
  }
}

// -------------------------------------------------------------------------
// configure_camera()
// -------------------------------------------------------------------------
void configure_camera() {
  Serial.println("Initializing camera...");
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = CAMERA_XCLK_FREQ;

  // Use config.h camera settings optimized for battery life
  config.frame_size   = CAMERA_FRAME_SIZE;
  config.pixel_format = PIXFORMAT_JPEG;
  config.fb_count     = 1;
  config.jpeg_quality = CAMERA_JPEG_QUALITY;
  config.fb_location  = CAMERA_FB_IN_PSRAM;
  config.grab_mode    = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    cameraInitialized = false;
  }
  else {
    Serial.println("Camera initialized successfully.");
    cameraInitialized = true;
  }
}

// -------------------------------------------------------------------------
// configure_microphone()
// -------------------------------------------------------------------------
bool configureMicrophone() {
  Serial.println("Initializing microphone...");
  
  // Check if I2S driver is already installed before uninstalling
  // Note: i2s_driver_uninstall will give an error if not installed, but it's harmless
  esp_err_t uninstall_result = i2s_driver_uninstall(I2S_PORT);
  if (uninstall_result == ESP_OK) {
    Serial.println("Previous I2S driver uninstalled");
  } else {
    Serial.println("No previous I2S driver to uninstall (expected)");
  }
  delay(100);
  
  // I2S configuration for XIAO ESP32S3 Sense built-in microphone (PDM mode)
  // Based on official Seeed Studio examples
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM),  // PDM mode
    .sample_rate = I2S_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,       // Mono microphone
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,                                 // Back to 4 as in Seeed examples
    .dma_buf_len = 1024,                                // Back to 1024 as in Seeed examples
    .use_apll = false,                                  // Back to false as in Seeed examples
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  // I2S pin configuration for PDM mode
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_PIN_NO_CHANGE,    // BCK not used in PDM mode
    .ws_io_num = I2S_WS,                // Clock pin for PDM (GPIO42)
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD               // Data pin for PDM (GPIO41)
  };

  // Install I2S driver
  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("❌ I2S driver install failed: %s\n", esp_err_to_name(err));
    microphoneInitialized = false;
    return false;
  }

  // Set pins
  err = i2s_set_pin(I2S_PORT, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("❌ I2S pin config failed: %s\n", esp_err_to_name(err));
    i2s_driver_uninstall(I2S_PORT);
    microphoneInitialized = false;
    return false;
  }

  // Clear buffer and stabilize
  i2s_zero_dma_buffer(I2S_PORT);
  delay(200);
  
  // Test read
  int16_t test_buffer[64];
  size_t bytes_read = 0;
  esp_err_t test_result = i2s_read(I2S_PORT, test_buffer, sizeof(test_buffer), &bytes_read, 1000);
  
  if (test_result == ESP_OK && bytes_read > 0) {
    Serial.printf("✅ Microphone initialized successfully - read %d bytes\n", bytes_read);
    microphoneInitialized = true;
    return true;
  } else {
    Serial.printf("❌ Microphone test failed: %s\n", esp_err_to_name(test_result));
    microphoneInitialized = false;
    return false;
  }
}

// -------------------------------------------------------------------------
// configure_ble()
// -------------------------------------------------------------------------
void configure_ble() {
  Serial.println("Initializing BLE...");
  
  // Initialize BLE
  BLEDevice::init(BLE_DEVICE_NAME);
  
  // Create BLE Server
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());
  
  // Create BLE Service
  pService = pServer->createService(serviceUUID);
  
  // Create Photo Data Characteristic
  photoDataCharacteristic = pService->createCharacteristic(
    photoDataUUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  photoDataCharacteristic->addDescriptor(new BLE2902());
  
  // Create Photo Control Characteristic
  photoControlCharacteristic = pService->createCharacteristic(
    photoControlUUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  photoControlCharacteristic->setCallbacks(new PhotoControlCallbacks());
  
  // Create Audio Data Characteristic  
  audioDataCharacteristic = pService->createCharacteristic(
    audioDataUUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  audioDataCharacteristic->addDescriptor(new BLE2902());
  
  // Create Audio Control Characteristic
  audioControlCharacteristic = pService->createCharacteristic(
    audioControlUUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  audioControlCharacteristic->setCallbacks(new AudioControlCallbacks());
  
  // Create Battery Level Characteristic
  BLEService *batteryService = pServer->createService(BLEUUID((uint16_t)BATTERY_SERVICE_UUID));
  batteryLevelCharacteristic = batteryService->createCharacteristic(
    BLEUUID((uint16_t)BATTERY_LEVEL_UUID),
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  batteryLevelCharacteristic->addDescriptor(new BLE2902());
  
  // Start services
  pService->start();
  batteryService->start();
  
  // Start advertising
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(serviceUUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);  // functions that help with iPhone connections issue
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  
  Serial.println("BLE initialized and advertising started");
}

// -------------------------------------------------------------------------
// BLE Callback Method Implementations
// -------------------------------------------------------------------------
void ServerCallbacks::onConnect(BLEServer* pServer) {
  connected = true;
  Serial.println("BLE client connected");
  lastActivity = millis();
}

void ServerCallbacks::onDisconnect(BLEServer* pServer) {
  connected = false;
  Serial.println("BLE client disconnected");
  delay(500); // give the bluetooth stack the chance to get things ready
  pServer->startAdvertising(); // restart advertising
  Serial.println("BLE advertising restarted");
}

void PhotoControlCallbacks::onWrite(BLECharacteristic *pCharacteristic) {
  std::string value = pCharacteristic->getValue();
  if (value.length() > 0) {
    int8_t controlValue = value[0];
    handlePhotoControl(controlValue);
  }
}

void AudioControlCallbacks::onWrite(BLECharacteristic *pCharacteristic) {
  std::string value = pCharacteristic->getValue();
  if (value.length() > 0) {
    int8_t controlValue = value[0];
    handleAudioControl(controlValue);
  }
}

// -------------------------------------------------------------------------
// Audio Processing Functions
// -------------------------------------------------------------------------

// Handle audio control commands from mobile app
void handleAudioControl(int8_t controlValue) {
  switch (controlValue) {
    case 1:  // Start voice activation
      Serial.println("🎤 Starting voice activation...");
      startVoiceActivation();
      break;
    case 0:  // Stop voice activation  
      Serial.println("🛑 Stopping voice activation...");
      stopVoiceActivation();
      break;
    case 2:  // Start recording command
      Serial.println("📝 Starting command recording...");
      startRecordingCommand();
      break;
    default:
      Serial.printf("⚠️ Unknown audio control: %d\n", controlValue);
      break;
  }
}

// Start voice activation (listen for wake word)
void startVoiceActivation() {
  if (!microphoneInitialized) {
    Serial.println("❌ Microphone not initialized");
    return;
  }
  
  voiceActivationEnabled = true;
  listeningForWakeWord = false;  // Disabled - using touch activation instead
  recordingCommand = false;
  audioBufferIndex = 0;
  
  Serial.println("🎤 Voice activation ready - using TOUCH sensor (wake word disabled)");
}

// Stop voice activation
void stopVoiceActivation() {
  voiceActivationEnabled = false;
  listeningForWakeWord = false;
  recordingCommand = false;
  audioBufferIndex = 0;
  
  Serial.println("🛑 Voice activation stopped");
}

// Start recording voice command after wake word detected
void startRecordingCommand() {
  if (!voiceActivationEnabled) {
    Serial.println("❌ Voice activation not enabled");
    return;
  }
  
  listeningForWakeWord = false;
  recordingCommand = true;
  audioBufferIndex = 0;
  
  Serial.println("📝 Recording voice command...");
}

// Enhanced wake word detection for "Lumina" using spectral analysis
bool detectWakeWord(int16_t* samples, size_t sampleCount) {
  // Calculate DC offset (average value) to remove bias
  float dcOffset = 0.0f;
  for (size_t i = 0; i < sampleCount; i++) {
    dcOffset += (float)samples[i];
  }
  dcOffset = dcOffset / sampleCount;
  
  // Calculate AC energy after removing DC offset and applying high-pass filter
  float acEnergy = 0.0f;
  int16_t minSample = 32767, maxSample = -32768;
  int validSampleCount = 0;
  
  for (size_t i = 0; i < sampleCount; i++) {
    // Remove DC offset to get AC component
    float acSample = (float)samples[i] - dcOffset;
    
    // Simple high-pass filter to remove low-frequency noise
    float filteredSample = acSample - (previousSample * 0.95f);
    previousSample = acSample;
    
    // Convert back to int16 and apply gain
    int16_t processedSample = (int16_t)(filteredSample * 16.0f);  // 16x amplification
    
    // Only count significant samples
    if (abs(processedSample) > 50) {
      acEnergy += (float)(processedSample * processedSample);
      if (processedSample < minSample) minSample = processedSample;
      if (processedSample > maxSample) maxSample = processedSample;
      validSampleCount++;
    }
  }
  
  if (validSampleCount > 5) {  // Need at least some valid samples
    acEnergy = acEnergy / validSampleCount;
    currentAudioLevel = sqrtf(acEnergy) / 32768.0f * 100.0f; // Convert to percentage
  } else {
    currentAudioLevel = 0.0f;
  }
  
  // Update peak level
  if (currentAudioLevel > peakAudioLevel) {
    peakAudioLevel = currentAudioLevel;
  }
  
  // Debug audio levels with DC offset info
  static unsigned long lastLevelDebug = 0;
  if (millis() - lastLevelDebug > 2000) {  // Every 2 seconds
    Serial.printf("🔊 Audio Level: %.1f%% | Peak: %.1f%% | DC Offset: %.0f | AC Range: %d to %d | Valid: %d/%d\n", 
                  currentAudioLevel, peakAudioLevel, dcOffset, minSample, maxSample, validSampleCount, sampleCount);
    lastLevelDebug = millis();
  }
  
  // Enhanced "Lumina" detection algorithm
  static int consecutiveHighEnergy = 0;
  static unsigned long lastWakeWordTime = 0;
  static float freqHistory[10] = {0}; // Store frequency characteristics
  static int historyIndex = 0;
  
  // Voice Activity Detection (VAD) - detect if it's speech vs noise
  bool isSpeech = detectSpeechActivity(samples, sampleCount);
  
  // Higher threshold and require actual speech characteristics
  if (currentAudioLevel > 6.0f && isSpeech) {  // Lowered from 8.0f to 6.0f
    consecutiveHighEnergy++;
    
    // Analyze frequency content for "Lumina" pattern
    float dominantFreq = getDominantFrequency(samples, sampleCount);
    freqHistory[historyIndex % 10] = dominantFreq;
    historyIndex++;
    
    // Only log when we have meaningful speech (not background noise)
    if (dominantFreq > 0) {
      Serial.printf("🎯 Speech detected: %.1f%% | Freq: %.0fHz (consecutive: %d)\n", 
                    currentAudioLevel, dominantFreq, consecutiveHighEnergy);
    }
    
    // "Lumina" has specific phonetic pattern: Lu-mi-na (3 syllables)
    // Look for syllable pattern and frequency characteristics  
    if (consecutiveHighEnergy >= 2 && consecutiveHighEnergy <= 8) { // Lowered minimum from 3 to 2
      if (isLuminaPattern(freqHistory, historyIndex) && (millis() - lastWakeWordTime > 2000)) {
        lastWakeWordTime = millis();
        consecutiveHighEnergy = 0;
        historyIndex = 0;
        Serial.println("🎉 LUMINA DETECTED!");
        return true;
      }
    }
    
    // Reset if too long (probably not "Lumina")
    if (consecutiveHighEnergy > 10) { // Shortened from 15 to 10
      consecutiveHighEnergy = 0;
      historyIndex = 0;
    }
  } else {
    // Gradual decay instead of immediate reset
    if (consecutiveHighEnergy > 0) {
      consecutiveHighEnergy--;
    }
  }
  
  return false;
}

// Detect if audio contains speech characteristics vs noise (improved)
bool detectSpeechActivity(int16_t* samples, size_t sampleCount) {
  // Calculate overall energy first
  float totalEnergy = 0.0f;
  for (size_t i = 0; i < sampleCount; i++) {
    totalEnergy += (float)(samples[i] * samples[i]);
  }
  totalEnergy = totalEnergy / sampleCount;
  
  // If energy is too low, it's just noise
  if (totalEnergy < 20000000.0f) { // Lowered threshold for noise rejection
    return false;
  }
  
  // Simple spectral centroid analysis for speech detection
  float lowFreqEnergy = 0.0f;   // 300-1000Hz (vowels)
  float midFreqEnergy = 0.0f;   // 1000-3000Hz (consonants)
  float highFreqEnergy = 0.0f;  // 3000-8000Hz (sibilants)
  
  // Simple frequency analysis (not perfect FFT, but lightweight)
  for (size_t i = 1; i < sampleCount/4; i++) {
    float sample1 = (float)samples[i-1];
    float sample2 = (float)samples[i];
    float diff = abs(sample2 - sample1);
    
    if (i < sampleCount/12) lowFreqEnergy += diff;      // Low freq approximation
    else if (i < sampleCount/6) midFreqEnergy += diff;  // Mid freq approximation  
    else highFreqEnergy += diff;                        // High freq approximation
  }
  
  // Speech typically has more energy in mid frequencies
  float totalSpectralEnergy = lowFreqEnergy + midFreqEnergy + highFreqEnergy;
  if (totalSpectralEnergy < 5000) return false; // Too quiet spectral content
  
  float midRatio = midFreqEnergy / totalSpectralEnergy;
  return (midRatio > 0.2f && midRatio < 0.8f); // Speech characteristic ranges
}

// Get dominant frequency (improved)
float getDominantFrequency(int16_t* samples, size_t sampleCount) {
  // Zero-crossing rate analysis (simpler than FFT)
  int zeroCrossings = 0;
  int threshold = 1000; // Noise threshold to avoid counting noise as crossings
  
  for (size_t i = 1; i < sampleCount; i++) {
    // Only count significant zero crossings (above noise floor)
    if (abs(samples[i]) > threshold || abs(samples[i-1]) > threshold) {
      if ((samples[i-1] >= 0 && samples[i] < 0) || (samples[i-1] < 0 && samples[i] >= 0)) {
        zeroCrossings++;
      }
    }
  }
  
  // Estimate frequency from zero-crossing rate
  float frequency = (float)zeroCrossings * MICROPHONE_SAMPLE_RATE / (2.0f * sampleCount);
  
  // Filter out unrealistic frequencies for human speech
  if (frequency < 50.0f || frequency > 4000.0f) {
    return 0.0f;
  }
  
  return frequency;
}

// Analyze if frequency pattern matches "Lumina" phonetics (improved)
bool isLuminaPattern(float* freqHistory, int historyLen) {
  if (historyLen < 2) return false; // Lowered from 3 to 2
  
  // "Lumina" phonetic analysis:
  // Lu- : vowel sound (200-600Hz) 
  // -mi-: higher frequency consonant + vowel (300-800Hz)
  // -na : nasal + vowel (250-650Hz)
  
  int recentSamples = min(historyLen, 4); // Reduced from 6 to 4
  float avgFreq = 0.0f;
  float minFreq = 10000.0f;
  float maxFreq = 0.0f;
  int validFreqCount = 0;
  
  for (int i = max(0, historyLen - recentSamples); i < historyLen; i++) {
    int idx = i % 10;
    if (freqHistory[idx] > 50.0f) { // Only count valid frequencies
      avgFreq += freqHistory[idx];
      validFreqCount++;
      if (freqHistory[idx] > maxFreq) maxFreq = freqHistory[idx];
      if (freqHistory[idx] < minFreq) minFreq = freqHistory[idx];
    }
  }
  
  if (validFreqCount < 1) return false; // Only need 1 valid sample now
  avgFreq /= validFreqCount;
  
  // "Lumina" characteristics (very lenient):
  // 1. Average frequency in human speech range (100-1200Hz)
  // 2. Some frequency variation OR consistent speech frequency
  // 3. In realistic speech range
  bool goodAvgFreq = (avgFreq >= 100.0f && avgFreq <= 1200.0f);
  bool hasVariation = (maxFreq - minFreq) >= 50.0f; // Reduced from 80Hz
  bool inSpeechRange = (maxFreq < 2500.0f && minFreq > 50.0f);
  bool consistentSpeech = (validFreqCount >= 1 && avgFreq > 200.0f); // New: allow consistent speech
  
  if (goodAvgFreq && (hasVariation || consistentSpeech) && inSpeechRange) {
    Serial.printf("🎶 Lumina pattern match: avg=%.0fHz, range=%.0f-%.0fHz (samples=%d)\n", 
                  avgFreq, minFreq, maxFreq, validFreqCount);
    return true;
  }
  
  return false;
}

// Send audio data via BLE
void sendAudioData(uint8_t* audioData, size_t length) {
  if (!connected || !audioDataCharacteristic) {
    return;
  }
  
  // Send in chunks (BLE MTU limitations)
  const size_t chunkSize = 200;
  for (size_t offset = 0; offset < length; offset += chunkSize) {
    size_t currentChunkSize = min(chunkSize, length - offset);
    
    // Create packet with frame index
    uint8_t packet[202];
    packet[0] = (offset / chunkSize) & 0xFF;  // Frame index low byte
    packet[1] = ((offset / chunkSize) >> 8) & 0xFF;  // Frame index high byte
    memcpy(&packet[2], &audioData[offset], currentChunkSize);
    
    audioDataCharacteristic->setValue(packet, currentChunkSize + 2);
    audioDataCharacteristic->notify();
    
    delay(10);  // Small delay between chunks
  }
}

// Process audio samples
void processAudio() {
  if (!microphoneInitialized) {
    // Only print this occasionally to avoid spam
    static unsigned long lastWarning = 0;
    if (millis() - lastWarning > 10000) {  // Every 10 seconds
      Serial.println("⚠️ Audio processing skipped - microphone not initialized");
      lastWarning = millis();
    }
    return;
  }
  
  if (!voiceActivationEnabled) {
    // Only print this occasionally to avoid spam  
    static unsigned long lastWarning2 = 0;
    if (millis() - lastWarning2 > 10000) {  // Every 10 seconds
      Serial.println("⚠️ Audio processing skipped - voice activation not enabled");
      lastWarning2 = millis();
    }
    return;
  }
  
  size_t bytes_read = 0;
  esp_err_t result = i2s_read(I2S_PORT, audioBuffer, sizeof(audioBuffer), &bytes_read, 0);
  
  if (result == ESP_OK && bytes_read > 0) {
    size_t samples_read = bytes_read / sizeof(int16_t);
    lastMicrophoneActivity = millis();
    
    // Debug audio activity occasionally
    static unsigned long lastAudioDebug = 0;
    if (millis() - lastAudioDebug > 5000) {  // Every 5 seconds
      Serial.printf("🎤 Audio: %d bytes read, %d samples, listening=%s\n", 
                    bytes_read, samples_read, listeningForWakeWord ? "YES" : "NO");
      lastAudioDebug = millis();
    }

    // -----------------------------------------------------------------
    // Unified audio level computation (mirrors microphone_test behavior)
    // DC offset removal + gain + noise gate + RMS of AC component.
    // Removed previous ad-hoc high-pass which was over-attenuating speech.
    // -----------------------------------------------------------------
    const float GAIN = 16.0f;        // Stronger gain so speech crosses threshold
    const int NOISE_GATE = 100;      // Ignore tiny fluctuations

    float dc_offset = 0.0f;
    for (size_t i = 0; i < samples_read; ++i) dc_offset += (float)audioBuffer[i];
    dc_offset /= (float)samples_read;

    float sum_squares = 0.0f;
    int16_t min_sample = 32767;
    int16_t max_sample = -32768;
    int valid_samples = 0;
    for (size_t i = 0; i < samples_read; ++i) {
      float ac = (float)audioBuffer[i] - dc_offset; // remove DC bias
      int16_t proc = (int16_t)(ac * GAIN);
      if (abs(proc) > NOISE_GATE) {
        if (proc < min_sample) min_sample = proc;
        if (proc > max_sample) max_sample = proc;
        sum_squares += (float)proc * (float)proc;
        valid_samples++;
      }
    }
    if (valid_samples > 0) {
      float rms = sqrtf(sum_squares / (float)valid_samples);
      currentAudioLevel = (rms / 32768.0f) * 100.0f;
    } else {
      currentAudioLevel = 0.0f;
    }
    if (currentAudioLevel > peakAudioLevel) peakAudioLevel = currentAudioLevel;

    // More frequent during calibration (every 1s)
    static unsigned long lastLevelPrint = 0;
    if (millis() - lastLevelPrint > 1000) {
      Serial.printf("🔊 (core) Level=%.1f%% | Peak=%.1f%% | DC=%.0f | AC range %d..%d | valid=%d/%d\n",
                    currentAudioLevel, peakAudioLevel, dc_offset, min_sample, max_sample, valid_samples, samples_read);
      lastLevelPrint = millis();
    }
    
    // Only process recording if touch-activated
    if (recordingCommand && (touchState == TOUCH_RECORDING_ACTIVE || touchState == TOUCH_RECORDING_SILENCE)) {
      // Touch recording: accumulate full session into large buffer
      size_t bytesToCopy = min(sizeof(audioBuffer), (size_t)(TOUCH_AUDIO_MAX_BYTES - touchAudioAccumIndex));
      if (bytesToCopy > 0) {
        memcpy(&touchAudioAccum[touchAudioAccumIndex], audioBuffer, bytesToCopy);
        touchAudioAccumIndex += bytesToCopy;
        Serial.printf("🎤 Touch recording accumulating: +%u (total=%u / %u)\n", 
                     (unsigned)bytesToCopy, (unsigned)touchAudioAccumIndex, (unsigned)TOUCH_AUDIO_MAX_BYTES);
      } else {
        Serial.println("⚠️ Touch audio buffer full - stopping accumulation");
      }
    }
  }
}

// -------------------------------------------------------------------------
// Setup & Loop
// -------------------------------------------------------------------------

// A small buffer for sending photo chunks over BLE
static uint8_t *s_compressed_frame_2 = nullptr;

void setup_app() {
  Serial.begin(921600);
  Serial.println("Setup started...");

  // Initialize GPIO
  pinMode(POWER_BUTTON_PIN, INPUT_PULLUP);
  pinMode(STATUS_LED_PIN, OUTPUT);

  // LED uses inverted logic: HIGH = OFF, LOW = ON
  digitalWrite(STATUS_LED_PIN, HIGH);
  
  // Setup button interrupt
  attachInterrupt(digitalPinToInterrupt(POWER_BUTTON_PIN), buttonISR, CHANGE);
  
  // Start LED boot sequence
  ledMode = LED_BOOT_SEQUENCE;
  
  // Power optimization from config.h
  setCpuFrequencyMhz(NORMAL_CPU_FREQ_MHZ);
  lastActivity = millis();
  
  configure_ble();
  configure_camera();
  
  // Initialize touch sensor for accessibility
  Serial.println("=== INITIALIZING TOUCH SENSOR ===");
  initializeTouchSensor();
  Serial.println("✅ Touch sensor initialization complete!");
  
  // Initialize hardware microphone for voice activation
  Serial.println("=== INITIALIZING MICROPHONE ===");
  if (configureMicrophone()) {
    Serial.println("✅ Microphone initialization successful!");
  } else {
    Serial.println("❌ Microphone initialization failed!");
  }

  // Allocate buffer for photo chunks (200 bytes + 2 for frame index)
  s_compressed_frame_2 = (uint8_t *)ps_calloc(202, sizeof(uint8_t));
  if (!s_compressed_frame_2) {
    Serial.println("Failed to allocate chunk buffer!");
  } else {
    Serial.println("Chunk buffer allocated successfully.");
  }

  // VOICE-ACTIVATED ONLY - No automatic photo capture
  isCapturingPhotos = false;  // Only capture when wake word detected
  captureInterval = 0;        // No interval-based capture
  lastCaptureTime = 0;
  Serial.println("Voice activation enabled - photos will only be captured when 'Lumina' is detected");
  
  // Start listening for wake word if microphone is initialized
  if (microphoneInitialized) {
    startVoiceActivation();
    Serial.println("Hardware voice activation started - listening for 'Lumina'");
  } else {
    Serial.println("Warning: Microphone not initialized - voice activation disabled");
  }
  
  // Initial battery reading
  // Battery voltage divider
  analogReadResolution(12); // optional: set 12-bit resolution
  analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db); // set attenuation for full 3.3V range
  
  readBatteryLevel();
  deviceState = DEVICE_ACTIVE;
  
  Serial.println("Setup complete.");
  Serial.println("Light sleep optimization enabled for extended battery life.");
}

void loop_app() {
  unsigned long now = millis();

  // Handle button presses
  handleButton();
  
  // Handle touch sensor for accessibility
  handleTouchSensor();
  
  // Process audio for voice activation
  processAudio();
  
  // Update LED
  updateLED();
  
  // Check for power save mode (gentle optimization)
  if (!connected && !photoDataUploading && (now - lastActivity > IDLE_THRESHOLD_MS)) {
    enterPowerSave();
  } else if (connected || photoDataUploading) {
    if (powerSaveMode) exitPowerSave();
    lastActivity = now;
  }

  // Check battery level periodically
  if (now - lastBatteryCheck >= BATTERY_TASK_INTERVAL_MS) {
    readBatteryLevel();
    updateBatteryService();
    lastBatteryCheck = now;
  }
  
  // Force battery update on first connection
  static bool firstBatteryUpdate = true;
  if (connected && firstBatteryUpdate) {
    readBatteryLevel();
    updateBatteryService();
    firstBatteryUpdate = false;
  }

  // Check if it's time to capture a photo
  if (isCapturingPhotos && !photoDataUploading && connected) {
    if ((captureInterval == 0) || (now - lastCaptureTime >= (unsigned long)captureInterval)) {
      if (captureInterval == 0) {
        // Single shot if interval=0
        isCapturingPhotos = false;
      }
      Serial.println("Interval reached. Capturing photo...");
      if (take_photo()) {
        Serial.println("Photo capture successful. Starting upload...");
        photoDataUploading = true;
        sent_photo_bytes = 0;
        sent_photo_frames = 0;
        lastCaptureTime = now;
      }
    }
  }

  // If uploading, send chunks over BLE
  if (photoDataUploading && fb) {
    size_t remaining = fb->len - sent_photo_bytes;
    if (remaining > 0) {
      // Check if we're in touch recording mode to prioritize audio processing
      bool isTouchRecording = (touchState == TOUCH_RECORDING_ACTIVE || touchState == TOUCH_RECORDING_SILENCE);
      
      // Prepare chunk
      s_compressed_frame_2[0] = (uint8_t)(sent_photo_frames & 0xFF);
      s_compressed_frame_2[1] = (uint8_t)((sent_photo_frames >> 8) & 0xFF);
      size_t bytes_to_copy = (remaining > 200) ? 200 : remaining;
      memcpy(&s_compressed_frame_2[2], &fb->buf[sent_photo_bytes], bytes_to_copy);

      photoDataCharacteristic->setValue(s_compressed_frame_2, bytes_to_copy + 2);
      photoDataCharacteristic->notify();

      sent_photo_bytes += bytes_to_copy;
      sent_photo_frames++;

      // Only print detailed progress occasionally during touch recording to avoid blocking audio
      if (!isTouchRecording || (sent_photo_frames % 10 == 0)) {
        Serial.print("Uploading chunk ");
        Serial.print(sent_photo_frames);
        Serial.print(" (");
        Serial.print(bytes_to_copy);
        Serial.print(" bytes), ");
        Serial.print(remaining - bytes_to_copy);
        Serial.println(" bytes remaining.");
      }
      
      lastActivity = now; // Register activity
    }
    else {
      // End of photo marker
      s_compressed_frame_2[0] = 0xFF;
      s_compressed_frame_2[1] = 0xFF;
      photoDataCharacteristic->setValue(s_compressed_frame_2, 2);
      photoDataCharacteristic->notify();
      Serial.println("Photo upload complete.");

      photoDataUploading = false;
      // Free camera buffer
      esp_camera_fb_return(fb);
      fb = nullptr;
      Serial.println("Camera frame buffer freed.");
    }
  }

  // Light sleep optimization - major power savings while maintaining BLE
  if (!photoDataUploading) {
    enableLightSleep();
  }
  
  // Adaptive delays for power saving (gentle optimization)
  // CRITICAL: During touch recording, minimize delays to maintain continuous audio processing
  bool isTouchRecording = (touchState == TOUCH_RECORDING_ACTIVE || touchState == TOUCH_RECORDING_SILENCE);
  
  if (photoDataUploading && isTouchRecording) {
    // Touch recording should be complete before photo upload now
    delay(20);  // Normal upload speed - no audio interference
  } else if (photoDataUploading) {
    delay(20);  // Normal upload speed when not recording audio
  } else if (powerSaveMode) {
    delay(50);  // Reduced delay with light sleep
  } else {
    delay(50);  // Reduced delay with light sleep
  }
}

// =============================================================================
// TOUCH SENSOR IMPLEMENTATION - Accessible alternative to voice activation
// =============================================================================

void initializeTouchSensor() {
  // Initialize touch sensor on GPIO3
  touchAttachInterrupt(TOUCH_SENSOR_PIN, NULL, TOUCH_THRESHOLD);
  touchState = TOUCH_IDLE;
  touchActivationMode = true;  // Always enabled for hardware-only operation
  Serial.printf("Touch sensor initialized on GPIO%d with threshold %d\n", TOUCH_SENSOR_PIN, TOUCH_THRESHOLD);
}

bool isTouchDetected() {
  // Read touch value (lower values mean touch detected)
  uint16_t touchValue = touchRead(TOUCH_SENSOR_PIN);
  
  // Debug touch values occasionally
  static unsigned long lastTouchDebug = 0;
  if (millis() - lastTouchDebug > 3000) {  // Every 3 seconds
    Serial.printf("👆 Touch value: %d (threshold: %d) %s\n", 
                  touchValue, TOUCH_THRESHOLD, 
                  touchValue < TOUCH_THRESHOLD ? "TOUCHED" : "not touched");
    lastTouchDebug = millis();
  }
  
  return touchValue < TOUCH_THRESHOLD;
}

void handleTouchSensor() {
  unsigned long now = millis();
  
  switch (touchState) {
    case TOUCH_IDLE:
      if (isTouchDetected()) {
        // Debounce touch detection
        if (now - lastTouchTime > TOUCH_DEBOUNCE_MS) {
          touchState = TOUCH_DETECTED;
          lastTouchTime = now;
          Serial.println("🔥 TOUCH DETECTED! Ready to record...");
          Serial.println("💡 Get ready to speak - recording will start when you release your finger!");
          
          // Flash LED to indicate touch detected
          ledMode = LED_PHOTO_CAPTURE;
          blinkLED(2, 200);
        }
      }
      break;
      
    case TOUCH_DETECTED:
      if (!isTouchDetected()) {
        // Touch released, start recording immediately
        touchState = TOUCH_RECORDING_ACTIVE;
        touchRecordingStartTime = now;
        lastSpeechTime = now;
        silenceStartTime = 0;
        Serial.println("📝 Touch released! Recording until 2s silence...");
        
        // Start recording audio for backend - independent of voice system
        if (!recordingCommand) {
          recordingCommand = true;
          audioBufferIndex = 0;
          touchAudioAccumIndex = 0; // reset accumulation buffer
          
          // Disable voice wake word listening during touch recording
          bool wasListening = listeningForWakeWord;
          listeningForWakeWord = false;
          
          Serial.println("🎤 Starting touch-activated recording (speak now!)");
          Serial.printf("🔧 Voice listening disabled: %s -> %s\n", 
                       wasListening ? "YES" : "NO", "NO");
        }
        
        // NOTE: Photo will be taken AFTER audio recording completes to avoid BLE interference
        Serial.println("📸 Photo will be captured after audio recording completes...");
        
        // Set LED to indicate recording
        ledMode = LED_NORMAL_OPERATION;
      }
      break;
      
    case TOUCH_RECORDING_ACTIVE:
      // Check for speech activity
      if (currentAudioLevel > SILENCE_THRESHOLD) {
        // Speech detected - reset silence timer
        lastSpeechTime = now;
        silenceStartTime = 0;
        Serial.printf("🎤 SPEECH: Level=%.1f%% (thresh=%.1f%%) - Recording continues\n", currentAudioLevel, SILENCE_THRESHOLD);
      } else {
        // Silence detected
        if (silenceStartTime == 0) {
          // Start counting silence
          silenceStartTime = now;
          touchState = TOUCH_RECORDING_SILENCE;
          Serial.printf("🤫 SILENCE START: Level=%.1f%% (thresh=%.1f%%) - %ds timer started\n", currentAudioLevel, SILENCE_THRESHOLD, TOUCH_SILENCE_DURATION_MS/1000);
        }
      }
      
      // Safety timeout (max 30 seconds)
      if (now - touchRecordingStartTime >= TOUCH_ACTIVATION_TIMEOUT) {
        Serial.println("⏰ Maximum recording time reached! Processing...");
        touchState = TOUCH_PROCESSING;
      }
      break;
      
    case TOUCH_RECORDING_SILENCE:
      // Check if speech resumed
      if (currentAudioLevel > SILENCE_THRESHOLD) {
        // Speech resumed - go back to active recording
        touchState = TOUCH_RECORDING_ACTIVE;
        lastSpeechTime = now;
        silenceStartTime = 0;
        Serial.printf("🎤 Speech resumed (%.1f%%) - back to recording\n", currentAudioLevel);
      } else {
        // Continue counting silence
        unsigned long silenceDuration = now - silenceStartTime;
        Serial.printf("🤫 SILENCE: %.1fs / %ds (Level=%.1f%%, thresh=%.1f%%)\n", 
                     silenceDuration/1000.0f, TOUCH_SILENCE_DURATION_MS/1000, currentAudioLevel, SILENCE_THRESHOLD);
        
        if (silenceDuration >= TOUCH_SILENCE_DURATION_MS) {
          // 4 seconds of silence - stop recording
          unsigned long totalRecordingTime = now - touchRecordingStartTime;
          
          if (totalRecordingTime >= TOUCH_MIN_RECORDING_MS) {
            Serial.printf("✅ Recording complete! Duration: %lums (%ds silence detected)\n", totalRecordingTime, TOUCH_SILENCE_DURATION_MS/1000);
            touchState = TOUCH_PROCESSING;
          } else {
            Serial.printf("⚠️ Recording too short (%lums) - continuing...\n", totalRecordingTime);
            touchState = TOUCH_RECORDING_ACTIVE;
            silenceStartTime = 0;
          }
        }
      }
      
      // Safety timeout
      if (now - touchRecordingStartTime >= TOUCH_ACTIVATION_TIMEOUT) {
        Serial.println("⏰ Maximum recording time reached during silence! Processing...");
        touchState = TOUCH_PROCESSING;
      }
      break;
      
    case TOUCH_PROCESSING:
      // Stop recording and send data
      if (recordingCommand) {
        recordingCommand = false; // Stop recording immediately
        Serial.printf("📤 Sending final touch audio data: %u bytes accumulated\n", (unsigned)touchAudioAccumIndex);
        if (touchAudioAccumIndex > 0) {
          sendAudioData(touchAudioAccum, touchAudioAccumIndex);
          Serial.printf("✅ Touch-activated FULL SESSION sent: %u bytes (%.1fs audio)\n", (unsigned)touchAudioAccumIndex, (float)touchAudioAccumIndex / (16000.0f * 2.0f));
        } else if (audioBufferIndex > 0) {
          // Fallback if accumulation somehow empty
          sendAudioData(bleAudioBuffer, audioBufferIndex);
          Serial.println("✅ Touch-activated voice recording sent (fallback small buffer)");
        } else {
          Serial.println("⚠️ No audio data captured during touch recording!");
        }
        audioBufferIndex = 0;
        touchAudioAccumIndex = 0;
        
        // Keep wake word disabled - we only use touch activation
        listeningForWakeWord = false;
        Serial.println("🎤 Touch recording complete - ready for next touch activation");
        
        // NOW take photo after audio is complete (no BLE interference!)
        Serial.println("📸 Now taking photo after audio recording completed...");
        if (!isCapturingPhotos) {
          isCapturingPhotos = true;
          captureInterval = 0;  // Single shot
        }
      }
      
      // Check if photo capture is complete before resetting to idle
      if (!isCapturingPhotos) {
        // Flash LED to indicate processing complete
        ledMode = LED_PHOTO_CAPTURE;
        blinkLED(3, 100);
        
        // Reset to idle state
        touchState = TOUCH_IDLE;
        touchActivationMode = false;
        ledMode = LED_NORMAL_OPERATION;
        
        Serial.println("🔄 Touch activation complete. Ready for next touch.");
      }
      break;
  }
}
