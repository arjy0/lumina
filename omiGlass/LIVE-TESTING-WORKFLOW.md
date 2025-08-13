# 🔴 OpenGlass Live Testing Workflow

## **Complete End-to-End Testing Steps**

### **Prerequisites:**
- ✅ Web app running (`npm start`)
- ✅ Connected to OpenGlass device via Web Bluetooth
- ✅ nRF Connect app on mobile
- ✅ Small test image converted to bytes

---

## **🚀 Live Testing Steps:**

### **Step 1: Activate OpenGlass**
1. **Click** the "🔴 Activate OpenGlass" button in the web app
2. **Observe:** Button changes to "⏳ Waiting for glasses..."
3. **Check logs:** You should see `📱 Activation command sent to mobile (glasses)`

### **Step 2: Send Image Data (Simulating Glasses Camera)**
1. **Open nRF Connect** on your mobile
2. **Connect** to your computer (the OpenGlass device)
3. **Find characteristic:** `19b10005-e8f2-537e-4f6c-d104768a1214`
4. **Send packets** in sequence:
   - **Data packets:** Each with format `[ID_LOW] [ID_HIGH] [DATA...]`
   - **End marker:** `FF FF`

### **Step 3: Automatic AI Processing**
**What happens automatically:**
1. ✅ **Photo received** and added to photos array
2. ✅ **Auto-processing triggered** (because isWaitingForResponse = true)
3. ✅ **AI analyzes** the image with Groq vision model
4. ✅ **TTS plays** the AI response through speakers

### **Step 4: Expected Results**
**You should see:**
- 📸 **Photos received:** count increases to 1
- 🤖 **OpenGlass Response:** AI description appears
- 🔊 **Audio:** AI speaks the response
- ✅ **Button:** Returns to "🔴 Activate OpenGlass"

---

## **🎯 Quick Test with Simple Data**

For quick testing without real images:

### **Option A: Simple Text Data**
```
Packet 1: 00 00 48 65 6C 6C 6F    (ID=0, "Hello")
End: FF FF
```

### **Option B: Real Image**
1. Use the `image-to-bytes-converter.html` tool
2. Upload a small image (< 1KB for easy testing)
3. Copy the generated hex packets
4. Send via nRF Connect

---

## **🔍 Debugging**

### **Expected Console Logs:**
```
🔴 OpenGlass activated!
📱 Activation command sent to mobile (glasses)
🔔 Notification received!
📨 Data packet received - ID: X
🏁 End marker received - processing photo
✅ Photo successfully added to state
📸 Photo effect triggered - isWaitingForResponse: true photos.length: 1
🚀 Auto-triggering processGlassesData...
🧠 Processing data from glasses...
🤖 Calling agent.answer...
🧠 Using Groq moonshotai/kimi-k2-instruct for direct image analysis
✅ Agent answered successfully
🔊 Playing TTS...
✅ TTS completed
```

### **If Something Goes Wrong:**
- **No AI response:** Check Groq API key in `keys.ts`
- **No TTS:** Check browser audio permissions
- **No packets:** Verify nRF Connect is connected to correct characteristic

---

## **🎉 Success Criteria**

**Complete success when you achieve:**
1. ✅ **Button activation** works
2. ✅ **Data transmission** from mobile to web
3. ✅ **AI vision analysis** processes the image
4. ✅ **TTS audio** plays the AI response
5. ✅ **UI updates** show the complete interaction

**This simulates the real glasses experience:**
- User presses glasses button → Web app activates
- Glasses camera takes photo → nRF Connect sends data  
- AI processes image → Groq analyzes and responds
- Response plays through speakers → User hears AI answer
