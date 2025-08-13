/**
 * Test data and functions for simulating OpenGlass photo data from nRF Connect
 */

// Create a simple test image as binary data (minimal PNG)
export function createTestPhotoData(): Uint8Array {
    // This is a minimal 1x1 pixel PNG in binary format
    const pngHeader = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
        0x49, 0x48, 0x44, 0x52, // IHDR
        0x00, 0x00, 0x00, 0x01, // Width: 1
        0x00, 0x00, 0x00, 0x01, // Height: 1
        0x08, 0x02, 0x00, 0x00, 0x00, // Bit depth: 8, Color type: 2 (RGB), Compression: 0, Filter: 0, Interlace: 0
        0x90, 0x77, 0x53, 0xDE, // CRC
        0x00, 0x00, 0x00, 0x0C, // IDAT chunk length
        0x49, 0x44, 0x41, 0x54, // IDAT
        0x08, 0x99, 0x01, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0xFC, 0x80, 0x00, // Image data (1 red pixel)
        0x00, 0x00, 0x00, 0x00, // IEND chunk length
        0x49, 0x45, 0x4E, 0x44, // IEND
        0xAE, 0x42, 0x60, 0x82  // CRC
    ]);
    
    return pngHeader;
}

// Simulate the packet structure that the real OpenGlass firmware sends
export function createPhotoPackets(photoData: Uint8Array): Array<{packetId: number, data: Uint8Array}> {
    const packets: Array<{packetId: number, data: Uint8Array}> = [];
    const maxPacketSize = 18; // BLE MTU minus headers
    
    let packetId = 0;
    let offset = 0;
    
    while (offset < photoData.length) {
        const chunkSize = Math.min(maxPacketSize, photoData.length - offset);
        const chunk = photoData.slice(offset, offset + chunkSize);
        
        packets.push({
            packetId: packetId,
            data: chunk
        });
        
        offset += chunkSize;
        packetId++;
    }
    
    // Add end packet (0xff, 0xff)
    packets.push({
        packetId: -1, // Special end packet
        data: new Uint8Array([0xff, 0xff])
    });
    
    return packets;
}

// Instructions for manually testing with nRF Connect
export const nrfTestInstructions = `
🧪 **How to Test Photo Data with nRF Connect:**

1. **In nRF Connect Server tab:**
   - Navigate to your Photo Data characteristic (19B10005-...)
   - You can manually send data to test the photo reception

2. **To send a test photo:**
   - Use the createTestPhotoData() function to get binary data
   - Split it into packets using createPhotoPackets()
   - Send each packet sequentially via notifications

3. **Packet Format:**
   - First 2 bytes: Packet ID (little endian)
   - Remaining bytes: Photo data chunk
   - Final packet: [0xFF, 0xFF] to signal end

4. **Example test sequence:**
   - Packet 0: [0x00, 0x00, ...photo_data_chunk_0...]
   - Packet 1: [0x01, 0x00, ...photo_data_chunk_1...]
   - ...
   - End: [0xFF, 0xFF]

5. **Automated test:**
   - The app can automatically send test data when you trigger it
`;

console.log('nRF Test Instructions:', nrfTestInstructions);
