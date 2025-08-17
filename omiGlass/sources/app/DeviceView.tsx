import * as React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { rotateImage } from '../modules/imaging';
import { toBase64Image } from '../utils/base64';
import { Agent } from '../agent/Agent';
import { InvalidateSync } from '../utils/invalidateSync';
import { textToSpeech } from '../modules/groq';
import { transcribePcm16 } from '../modules/groq';

// JPEG Analysis function
function analyzeJPEGStructure(data: Uint8Array) {
    if (data.length < 10) return { error: 'Too small to be JPEG' };
    
    const analysis = {
        size: data.length,
        hasSOI: data[0] === 0xFF && data[1] === 0xD8, // Start of Image
        hasEOI: false,
        segments: [] as Array<{marker: string, offset: number, size?: number}>,
        isValid: false,
        hasTables: {
            quantization: false,
            huffman: false,
            startOfFrame: false,
            startOfScan: false
        },
        warnings: [] as string[]
    };
    
    // Check for End of Image marker
    if (data.length >= 2) {
        analysis.hasEOI = data[data.length - 2] === 0xFF && data[data.length - 1] === 0xD9;
    }
    
    // Parse JPEG segments
    let offset = 0;
    let foundSOS = false;
    while (offset < data.length - 1) {
        if (data[offset] === 0xFF) {
            const marker = data[offset + 1];
            const markerName = getJPEGMarkerName(marker);
            
            // Track important tables
            if (marker === 0xDB) analysis.hasTables.quantization = true;
            if (marker === 0xC4) analysis.hasTables.huffman = true;
            if (marker >= 0xC0 && marker <= 0xC3) analysis.hasTables.startOfFrame = true;
            if (marker === 0xDA) {
                analysis.hasTables.startOfScan = true;
                foundSOS = true;
            }
            
            analysis.segments.push({
                marker: `0xFF${marker.toString(16).padStart(2, '0').toUpperCase()} (${markerName})`,
                offset: offset
            });
            
            // Skip to next segment (simplified parsing)
            if (marker === 0xD8) { // SOI
                offset += 2;
            } else if (marker === 0xD9) { // EOI
                offset += 2;
                break;
            } else if (marker >= 0xD0 && marker <= 0xD7) { // RST markers
                offset += 2;
            } else if (marker === 0xDA) { // Start of Scan - rest is image data
                if (offset + 3 < data.length) {
                    const length = (data[offset + 2] << 8) | data[offset + 3];
                    offset += 2 + length;
                    // After SOS, everything until EOI is compressed image data
                    break;
                }
            } else if (offset + 3 < data.length) {
                // Most markers have length field
                const length = (data[offset + 2] << 8) | data[offset + 3];
                if (length < 2) {
                    analysis.warnings.push(`Invalid segment length ${length} at offset ${offset}`);
                    break;
                }
                offset += 2 + length;
            } else {
                analysis.warnings.push(`Truncated segment at offset ${offset}`);
                break;
            }
        } else {
            offset++;
        }
        
        // Safety check
        if (analysis.segments.length > 20) {
            analysis.warnings.push('Too many segments, parsing stopped');
            break;
        }
    }
    
    // Validate JPEG structure
    analysis.isValid = analysis.hasSOI && analysis.hasEOI && analysis.segments.length > 0;
    
    // Add warnings for missing essential components
    if (!analysis.hasTables.quantization) {
        analysis.warnings.push('Missing quantization tables (DQT)');
    }
    if (!analysis.hasTables.huffman) {
        analysis.warnings.push('Missing Huffman tables (DHT)');
    }
    if (!analysis.hasTables.startOfFrame) {
        analysis.warnings.push('Missing Start of Frame (SOF)');
    }
    if (!analysis.hasTables.startOfScan) {
        analysis.warnings.push('Missing Start of Scan (SOS)');
    }
    if (foundSOS && !analysis.hasEOI) {
        analysis.warnings.push('Image data found but no End of Image marker');
    }
    
    return analysis;
}

function getJPEGMarkerName(marker: number): string {
    const markers: Record<number, string> = {
        0xD8: 'SOI - Start of Image',
        0xD9: 'EOI - End of Image',
        0xDA: 'SOS - Start of Scan',
        0xDB: 'DQT - Quantization Table',
        0xDC: 'DNL - Number of Lines',
        0xDD: 'DRI - Restart Interval',
        0xDE: 'DHP - Hierarchical Progression',
        0xDF: 'EXP - Expand Reference',
        0xE0: 'APP0 - Application',
        0xE1: 'APP1 - EXIF',
        0xFE: 'COM - Comment',
        0xC0: 'SOF0 - Start of Frame',
        0xC4: 'DHT - Huffman Table'
    };
    return markers[marker] || `Unknown (0x${marker.toString(16)})`;
}

function hexDump(data: Uint8Array, start: number, length: number): string {
    const end = Math.min(start + length, data.length);
    const bytes = Array.from(data.slice(start, end));
    return bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function usePhotos(device: BluetoothRemoteGATTServer) {

    // Subscribe to device
    const [photos, setPhotos] = React.useState<Array<{ data: Uint8Array; timestamp: number }>>([]);
    const [subscribed, setSubscribed] = React.useState<boolean>(false);
    React.useEffect(() => {
        (async () => {

            let previousChunk = -1;
            let buffer: Uint8Array = new Uint8Array(0);
            let transmissionTimeout: NodeJS.Timeout | null = null;
            
            const clearTransmissionTimeout = () => {
                if (transmissionTimeout) {
                    clearTimeout(transmissionTimeout);
                    transmissionTimeout = null;
                }
            };
            
            // Auto-complete transmission if no data received for 2 seconds
            const setTransmissionTimeout = () => {
                clearTransmissionTimeout();
                transmissionTimeout = setTimeout(() => {
                    console.log('⏰ Transmission timeout - auto-completing image');
                    console.log('📸 Auto-completing with', buffer.length, 'bytes received');
                    console.log('🔍 TIMEOUT ANALYSIS:');
                    console.log('   - Expected: Complete JPEG starting with FF D8');
                    console.log('   - Received:', buffer.length, 'bytes');
                    console.log('   - First bytes:', buffer.length > 0 ? Array.from(buffer.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'none');
                    console.log('   - Last bytes:', buffer.length > 8 ? Array.from(buffer.slice(-8)).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'none');
                    
                    if (buffer.length > 500) { // Only process if we have substantial data
                        console.log('✅ Sufficient data for AI processing');
                        
                        // CRITICAL: Check if we have JPEG header
                        const hasJPEGHeader = buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8;
                        
                        if (!hasJPEGHeader && buffer.length > 0) {
                            console.warn('⚠️ CRITICAL: Missing JPEG header (FF D8)!');
                            console.warn('⚠️ This suggests transmission started mid-stream');
                            console.warn('⚠️ Device likely disconnected during a previous transmission');
                            console.warn('💡 SOLUTION: Use "Reset Device Transmission" button');
                            console.warn('💡 Then click "Activate OpenGlass" for fresh capture');
                            
                            // Skip this incomplete transmission and wait for next complete one
                            console.log('🔄 Skipping incomplete transmission, waiting for next complete image...');
                            console.log('🔄 TIP: Use the Reset button if this keeps happening');
                            buffer = new Uint8Array(0);
                            previousChunk = -1;
                            return;
                        }
                        
                        onChunk(null, new Uint8Array()); // Force end processing
                    } else {
                        console.log('⚠️ Insufficient data, waiting for more...');
                        previousChunk = -1; // Reset for next transmission
                    }
                }, 2000); // 2 second timeout
            };
            

            function onChunk(id: number | null, data: Uint8Array) {
                // Resolve if packet is the first one
                if (previousChunk === -1) {
                    if (id === null) {
                        console.log('⚠️ No data to process');
                        return;
                    } else {
                        // Start accepting packets from any ID (for testing with nRF Connect)
                        console.log(' new transmission with ID:', id);
                        previousChunk = id;
                        buffer = new Uint8Array(0);
                        // Continue to append this first packet
                    }
                } else {
                        if (id === null) {
                            console.log('🏁 End marker received - processing photo');
                            console.log('📸 Photo size:', buffer.length, 'bytes');
                            console.log('🔢 Photos array length before processing:', photos.length);
                            
                            // Clear timeout since we got proper end marker
                            clearTransmissionTimeout();
                            
                            // TRANSMISSION ANALYSIS - Check if we're getting incomplete data
                            console.log('🔍 TRANSMISSION ANALYSIS:');
                            console.log('  Buffer size:', buffer.length, 'bytes');
                            console.log('  Expected min JPEG size: ~400+ bytes for complete image');
                            console.log('  Buffer appears:', buffer.length < 500 ? 'SUSPICIOUSLY SMALL' : 'normal size');
                            
                            // Quick JPEG validity check before processing
                            const hasValidStart = buffer.length > 2 && buffer[0] === 0xFF && buffer[1] === 0xD8;
                            const hasValidEnd = buffer.length > 2 && buffer[buffer.length - 2] === 0xFF && buffer[buffer.length - 1] === 0xD9;
                            console.log('🔍 Quick JPEG check:', { hasValidStart, hasValidEnd, size: buffer.length });
                            
                            if (hasValidStart && hasValidEnd && buffer.length < 1000) {
                                console.warn('⚠️ WARNING: Very small JPEG detected!');
                                console.warn('⚠️ This suggests the transmission was cut short');
                                console.warn('⚠️ Device may not be sending complete image data');
                            }                        try {
                            const timestamp = Date.now();
                            
                            // First, check if this is already binary JPEG data (sent as hex)
                            console.log('🔍 First 20 bytes as hex:', Array.from(buffer.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' '));
                            
                            // Check for JPEG binary signature first (FF D8)
                            const isDirectJPEG = buffer.length > 10 && buffer[0] === 0xFF && buffer[1] === 0xD8;
                            
                            // Check if JPEG is complete (should end with FF D9)
                            const hasJPEGEndMarker = buffer.length > 2 && buffer[buffer.length - 2] === 0xFF && buffer[buffer.length - 1] === 0xD9;
                            
                            console.log('🔍 Direct JPEG binary detection:', { 
                                isDirectJPEG, 
                                bufferLength: buffer.length,
                                hasJPEGEndMarker,
                                lastTwoBytes: buffer.length > 2 ? Array.from(buffer.slice(-2)).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'N/A'
                            });
                            
                            if (isDirectJPEG && !hasJPEGEndMarker) {
                                console.warn('⚠️ JPEG detected but appears incomplete - missing FF D9 end marker');
                                console.warn('⚠️ This may cause the image to appear black/corrupted');
                                console.warn('⚠️ Image size:', buffer.length, 'bytes (may be truncated)');
                            }
                            
                            if (isDirectJPEG) {
                                console.log('�️ Direct JPEG binary data detected!');
                                console.log('🔍 JPEG header validation:', Array.from(buffer.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(' '));
                                
                                // This is already a valid JPEG image - use it directly
                                try {
                                    console.log('✅ Processing direct JPEG binary, size:', buffer.length, 'bytes');
                                    
                                    // Add debug: create downloadable blob to inspect the image
                                    try {
                                        const debugBlob = new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' });
                                        const debugUrl = URL.createObjectURL(debugBlob);
                                        console.log('🔍 Debug: Image blob URL (copy to browser):', debugUrl);
                                        console.log('🔍 Debug: Image signature check:', {
                                            'first4bytes': Array.from(buffer.slice(0, 4)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
                                            'last4bytes': Array.from(buffer.slice(-4)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
                                            'isValidJPEG': buffer[0] === 0xFF && buffer[1] === 0xD8,
                                            'hasJPEGEnd': buffer[buffer.length-2] === 0xFF && buffer[buffer.length-1] === 0xD9
                                        });
                                        
                                        // Test if browser can decode this image
                                        console.log('🧪 Testing image load in browser...');
                                        const testImg = document.createElement('img');
                                        testImg.onload = () => {
                                            console.log('✅ Browser successfully loaded image:', {
                                                naturalWidth: testImg.naturalWidth,
                                                naturalHeight: testImg.naturalHeight,
                                                complete: testImg.complete
                                            });
                                        };
                                        testImg.onerror = (error) => {
                                            console.error('❌ Browser failed to load image:', error);
                                            console.error('🔍 This explains why Groq rejects it - the image data is corrupted');
                                            if (error && typeof error === 'object' && 'type' in error) {
                                                console.error('🔍 Error details:', {
                                                    type: (error as Event).type,
                                                    target: (error as Event).target,
                                                    currentSrc: ((error as Event).target as any)?.currentSrc || 'N/A'
                                                });
                                            }
                                        };
                                        testImg.src = debugUrl;
                                        
                                        // Also create a data URL to test
                                        let binaryString = '';
                                        for (let i = 0; i < buffer.length; i++) {
                                            binaryString += String.fromCharCode(buffer[i]);
                                        }
                                        const base64 = btoa(binaryString);
                                        const dataUrl = `data:image/jpeg;base64,${base64}`;
                                        console.log('🔍 Debug: Data URL (first 100 chars):', dataUrl.substring(0, 100));
                                        
                                        const testImg2 = document.createElement('img');
                                        testImg2.onload = () => {
                                            console.log('✅ Data URL image loaded successfully');
                                        };
                                        testImg2.onerror = (error) => {
                                            console.error('❌ Data URL image failed to load:', error);
                                        };
                                        testImg2.src = dataUrl;
                                        
                                        // Analyze JPEG structure
                                        console.log('🔍 JPEG Structure Analysis:');
                                        const jpegAnalysis = analyzeJPEGStructure(buffer);
                                        console.log(jpegAnalysis);
                                        
                                        if ('warnings' in jpegAnalysis && jpegAnalysis.warnings.length > 0) {
                                            console.warn('⚠️ JPEG Structure Warnings:', jpegAnalysis.warnings);
                                            
                                            // Provide specific guidance based on warnings
                                            if (jpegAnalysis.warnings.includes('Missing Huffman tables (DHT)') || 
                                                jpegAnalysis.warnings.includes('Missing Start of Frame (SOF)') ||
                                                jpegAnalysis.warnings.includes('Missing Start of Scan (SOS)')) {
                                                console.error('🚨 CRITICAL: JPEG is structurally incomplete!');
                                                console.error('💡 LIKELY CAUSES:');
                                                console.error('   1. Device firmware sending truncated JPEG data');
                                                console.error('   2. Bluetooth transmission buffer overflow');
                                                console.error('   3. Device camera module producing corrupt images');
                                                console.error('🔧 SUGGESTED FIXES:');
                                                console.error('   1. Check device firmware version');
                                                console.error('   2. Try different image quality settings');
                                                console.error('   3. Check Bluetooth connection stability');
                                                console.error('   4. Restart OpenGlass device');
                                            }
                                        }
                                        
                                        // Show hex dump of key areas
                                        console.log('🔍 Hex dump analysis:');
                                        console.log('  Start (first 32 bytes):', hexDump(buffer, 0, 32));
                                        console.log('  End (last 32 bytes):', hexDump(buffer, Math.max(0, buffer.length - 32), 32));
                                        
                                        // Show segments found
                                        if ('segments' in jpegAnalysis && jpegAnalysis.segments.length > 0) {
                                            console.log('🔍 JPEG segments found:');
                                            jpegAnalysis.segments.forEach((seg: any, i: number) => {
                                                console.log(`  ${i + 1}. ${seg.marker} at offset ${seg.offset}`);
                                            });
                                        }
                                        
                                    } catch (debugError) {
                                        console.log('Debug blob creation failed:', debugError);
                                    }
                                    
                                    console.log('🔄 Starting image rotation...');
                                    rotateImage(buffer, '270').then((rotated) => {
                                        console.log('✅ JPEG image rotated successfully, new size:', rotated.length, 'bytes');
                                        setPhotos((p) => [...p, { data: rotated, timestamp: timestamp }]);
                                    }).catch((error) => {
                                        console.error('❌ JPEG rotation failed, using original:', error);
                                        console.log('💡 Fallback: Adding original image without rotation');
                                        setPhotos((p) => [...p, { data: buffer, timestamp: timestamp }]);
                                    });
                                    
                                    // Clear buffer and exit to prevent duplicate processing
                                    previousChunk = -1;
                                    return; // Exit the entire function to prevent duplicate photos
                                } catch (error) {
                                    console.error('❌ Error processing direct JPEG:', error);
                                    // Fall through to other detection methods
                                }
                            }
                            
                            // Check if this is base64-encoded image data sent as bytes
                            const dataAsString = new TextDecoder().decode(buffer);
                            console.log('🔍 Data as string length:', dataAsString.length);
                            console.log('🔍 Data preview:', dataAsString.substring(0, 100));
                            
                            // Check if this looks like actual base64 text (not binary)
                            const hasNullBytes = Array.from(buffer.slice(0, 50)).some(b => b === 0);
                            const hasHighBytes = Array.from(buffer.slice(0, 50)).some(b => b > 127);
                            console.log('🔍 Binary analysis:', { hasNullBytes, hasHighBytes });
                            
                            // Check if this could be base64 string sent as ASCII bytes
                            const isAsciiBase64 = !hasNullBytes && !hasHighBytes && dataAsString.length > 100;
                            const startsWithBase64 = dataAsString.startsWith('/9j/') || dataAsString.startsWith('iVBORw0KGgo') || dataAsString.startsWith('R0lGOD');
                            
                            console.log('🔍 ASCII Base64 detection:', {
                                isAsciiBase64,
                                startsWithBase64,
                                dataPreview: dataAsString.substring(0, 20)
                            });
                            
                            // Note: Force decode removed - direct JPEG detection is working perfectly now
                            
                            if (isAsciiBase64 && startsWithBase64) {
                                console.log('📸 Base64 string (sent as ASCII bytes) detected, decoding...');
                                try {
                                    // The dataAsString IS the base64 string (was sent as ASCII bytes)
                                    const binaryString = atob(dataAsString.trim());
                                    const imageBytes = new Uint8Array(binaryString.length);
                                    for (let i = 0; i < binaryString.length; i++) {
                                        imageBytes[i] = binaryString.charCodeAt(i);
                                    }
                                    
                                    console.log('✅ Base64 decoded successfully, image size:', imageBytes.length, 'bytes');
                                    console.log('🔍 Image header:', Array.from(imageBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
                                    
                                    // Validate JPEG signature
                                    const isValidJPEG = imageBytes[0] === 0xFF && imageBytes[1] === 0xD8;
                                    console.log('🔍 JPEG validation:', { isValidJPEG });
                                    
                                    if (isValidJPEG) {
                                        console.log('✅ Valid JPEG image detected!');
                                    }
                                    
                                    setPhotos((p) => [...p, { data: imageBytes, timestamp: timestamp }]);
                                    previousChunk = -1;
                                    return; // Exit early on successful base64 processing
                                } catch (decodeError) {
                                    console.error('❌ Base64 decode failed:', decodeError);
                                    setPhotos((p) => [...p, { data: buffer, timestamp: timestamp }]);
                                }
                            } else {
                                // Check if it's likely binary image data
                                console.log('🔍 Checking for binary image format...');
                                console.log('🔍 First 10 bytes:', Array.from(buffer.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(' '));
                                
                                const isLikelyImage = buffer.length > 10 && (
                                    (buffer[0] === 0xFF && buffer[1] === 0xD8) || // JPEG
                                    (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) || // PNG
                                    (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) // GIF
                                );
                                
                                console.log('🔍 Binary image detection:', { isLikelyImage });
                                
                                if (isLikelyImage) {
                                    console.log('🖼️ Processing binary image data...');
                                    rotateImage(buffer, '270').then((rotated) => {
                                        console.log('✅ Image processed successfully');
                                        setPhotos((p) => [...p, { data: rotated, timestamp: timestamp }]);
                                    }).catch((error) => {
                                        console.error('❌ Image processing failed:', error);
                                        setPhotos((p) => [...p, { data: buffer, timestamp: timestamp }]);
                                    });
                                } else {
                                    console.log('📝 Processing as raw data (may be corrupted base64 or unsupported format)');
                                    console.log('🔄 Attempting to treat as base64 anyway...');
                                    
                                    // Try to treat as base64 even if detection failed
                                    try {
                                        const base64String = dataAsString.replace(/[^A-Za-z0-9+/=]/g, ''); // Clean non-base64 chars
                                        if (base64String.length > 50) {
                                            console.log('🧪 Attempting base64 decode on cleaned string:', base64String.length, 'chars');
                                            const binaryString = atob(base64String);
                                            const imageBytes = new Uint8Array(binaryString.length);
                                            for (let i = 0; i < binaryString.length; i++) {
                                                imageBytes[i] = binaryString.charCodeAt(i);
                                            }
                                            console.log('🧪 Experimental decode result:', imageBytes.length, 'bytes');
                                            console.log('🧪 First 10 bytes:', Array.from(imageBytes.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(' '));
                                            setPhotos((p) => [...p, { data: imageBytes, timestamp: timestamp }]);
                                        } else {
                                            setPhotos((p) => [...p, { data: buffer, timestamp: timestamp }]);
                                        }
                                    } catch (experimentalError) {
                                        console.log('🧪 Experimental decode failed:', experimentalError);
                                        setPhotos((p) => [...p, { data: buffer, timestamp: timestamp }]);
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('❌ Error during photo processing:', error);
                            const timestamp = Date.now();
                            setPhotos((p) => [...p, { data: buffer, timestamp: timestamp }]);
                        }
                        
                        previousChunk = -1;
                        return;
                    } else {
                        if (id !== previousChunk + 1) {
                            previousChunk = -1;
                            console.error('❌ Invalid packet sequence:', id, 'expected:', previousChunk + 1);
                            return;
                        }
                        previousChunk = id;
                    }
                }

                // Append data
                buffer = new Uint8Array([...buffer, ...data]);
                console.log('📦 Packet', id, '- Buffer size:', buffer.length, 'bytes');
                
                // Set/reset timeout for each packet received
                setTransmissionTimeout();
            }

            try {
                console.log(': Trying to get omiGlass service...');
                // Subscribe for photo updates
                const service = await device.getPrimaryService('19B10000-E8F2-537E-4F6C-D104768A1214'.toLowerCase());
                console.log(': Got service successfully');
                
                console.log(': Getting photo data characteristic...');
                const photoCharacteristic = await service.getCharacteristic('19b10005-e8f2-537e-4f6c-d104768a1214');
                console.log(': Got photo data characteristic:', photoCharacteristic);
                
                console.log(': Starting notifications...');
                await photoCharacteristic.startNotifications();
                console.log(': Notifications started successfully');
                console.log(': Checking notification properties:', {
                    canNotify: photoCharacteristic.properties.notify,
                    canIndicate: photoCharacteristic.properties.indicate,
                    canRead: photoCharacteristic.properties.read
                });
                setSubscribed(true);
                
                photoCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
                    console.log('🔔 Notification received!', e);
                    let value = (e.target as BluetoothRemoteGATTCharacteristic).value!;
                    console.log('📦 Raw value:', value);
                    let array = new Uint8Array(value.buffer);
                    console.log('📊 Data array:', array);
                    console.log('📊 Hex data:', Array.from(array).map(b => b.toString(16).padStart(2, '0')).join(' '));
                    
                    if (array[0] == 0xff && array[1] == 0xff) {
                        console.log('🏁 End marker received - processing photo');
                        console.log('🔄 About to call onChunk(null, new Uint8Array())...');
                        try {
                            onChunk(null, new Uint8Array());
                            console.log('✅ onChunk call completed successfully');
                        } catch (error) {
                            console.error('❌ Error in onChunk call:', error);
                        }
                    } else {
                        // Check if this is direct image data (starting with JPEG signature)
                        if (array[0] === 0xFF && array[1] === 0xD8) {
                            console.log('📸 Direct JPEG data received (no packet format)');
                            // This is the entire image in one packet
                            onChunk(0, array);
                            // Immediately end the transmission
                            setTimeout(() => onChunk(null, new Uint8Array()), 10);
                        } else {
                            let packetId = array[0] + (array[1] << 8);
                            let packet = array.slice(2);
                            console.log('📨 Data packet received - ID:', packetId, 'Data length:', packet.length);
                            onChunk(packetId, packet);
                        }
                    }
                });
                
                console.log(': Getting photo control characteristic...');
                const photoControlCharacteristic = await service.getCharacteristic('19b10006-e8f2-537e-4f6c-d104768a1214');
                console.log(': Got photo control characteristic:', photoControlCharacteristic);

                // Add audio data characteristic setup for touch-activated recordings
                console.log('🎵 Getting audio data characteristic...');
                try {
                    const audioCharacteristic = await service.getCharacteristic('19b10001-e8f2-537e-4f6c-d104768a1214');
                    console.log('✅ Got audio data characteristic:', audioCharacteristic);
                    console.log('🎵 Audio characteristic properties:', {
                        notify: audioCharacteristic.properties.notify,
                        read: audioCharacteristic.properties.read,
                        write: audioCharacteristic.properties.write
                    });
                    
                    if (!audioCharacteristic.properties.notify) {
                        console.error('❌ Audio characteristic does not support notifications!');
                    } else {
                        await audioCharacteristic.startNotifications();
                        console.log('✅ Audio notifications started successfully');
                        console.log('🎵 Audio characteristic UUID:', audioCharacteristic.uuid);
                        console.log('🎵 Waiting for audio data from touch activations...');
                        
                        // Improved accumulation strategy with inactivity timeout
                        let audioAssemble: Uint8Array[] = [];
                        let packetCount = 0;
                        let inactivityTimer: any = null;
                        let audioStreamEnded = false;
                        const INACTIVITY_MS = 2000; // Longer timeout for batch mode transmission
                        // Reduced threshold; firmware currently sends small bursts (~2KB)
                        // 2000 payload bytes ≈ 1000 samples ≈ 62.5ms @16kHz (still short but we will try)
                        const MIN_TRANSCRIBE_BYTES = 10000; // Expecting much larger batches now
                        const MAX_ACCUM_BYTES = 200000; // Updated cap for batch mode (~6s audio)
                        const resetInactivity = () => {
                            if (inactivityTimer) clearTimeout(inactivityTimer);
                            inactivityTimer = setTimeout(() => {
                                if (audioStreamEnded) return; // already dispatched
                                const total = audioAssemble.reduce((s, c) => s + c.length, 0);
                                console.log(`🎵 Inactivity timeout. Raw (with headers)=${total} bytes`);
                                if (total >= MIN_TRANSCRIBE_BYTES) {
                                    console.log('🎵 Dispatching (inactivity) touchAudioReceived');
                                    window.dispatchEvent(new CustomEvent('touchAudioReceived', { detail: { audioBuffer: [...audioAssemble] } }));
                                } else {
                                    console.warn(`⚠️ Short audio (${total} < ${MIN_TRANSCRIBE_BYTES}) sending anyway for STT (may fallback)`);
                                    window.dispatchEvent(new CustomEvent('touchAudioReceived', { detail: { audioBuffer: [...audioAssemble] } }));
                                }
                                audioStreamEnded = true;
                            }, INACTIVITY_MS);
                        };
                         
                         audioCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
                             const value = (e.target as BluetoothRemoteGATTCharacteristic).value!;
                             const dataArray = new Uint8Array(value.buffer);
                             packetCount++;
                             console.log(`🎵 AUDIO PKT ${packetCount}: ${dataArray.length} bytes`);
                            if (audioStreamEnded) return; // ignore stray packets after end
                            // Detect JPEG header accidentally coming over audio characteristic (start of photo)
                            if (dataArray.length >= 4 && dataArray[2] === 0xFF && dataArray[3] === 0xD8) {
                                console.log('📸 JPEG header detected in audio stream -> treat as end of audio, do not include JPEG bytes');
                                // Dispatch whatever audio we have
                                const total = audioAssemble.reduce((s,c)=>s+c.length,0);
                                if (total === 0) {
                                    console.warn('⚠️ No audio accumulated before JPEG start; ignoring');
                                } else {
                                    window.dispatchEvent(new CustomEvent('touchAudioReceived', { detail: { audioBuffer: [...audioAssemble] } }));
                                }
                                audioStreamEnded = true;
                                return;
                            }
                            audioAssemble.push(dataArray);
                             const totalNoHeaders = audioAssemble.reduce((s, c) => s + Math.max(0, c.length - 2), 0);
                             const estMs = (totalNoHeaders / 2) / 16; // samples/16 = ms at 16kHz
                             if (packetCount % 5 === 0) {
                                 console.log(`🎵 Accumulating: packets=${packetCount}, payloadBytes≈${totalNoHeaders}, estDuration≈${estMs.toFixed(0)}ms`);
                             }
                            if (totalNoHeaders >= MAX_ACCUM_BYTES) {
                                console.log('🎵 Reached MAX_ACCUM_BYTES cap, dispatching early');
                                window.dispatchEvent(new CustomEvent('touchAudioReceived', { detail: { audioBuffer: [...audioAssemble] } }));
                                audioStreamEnded = true;
                                return;
                            }
                             resetInactivity();
                         });
                     }
                 } catch (err) {
                     console.error('❌ Audio characteristic setup failed:', err);
                 }

                console.log(': Setup complete - device connected but in standby mode');
                console.log('🎤 IMPORTANT: Photos will ONLY be captured when voice commands are given');
                console.log('🎤 Proper workflow: Say "Lumina" → Ask question → Photo captured → AI processing');
                console.log('📱 No automatic photo capture - device waiting for voice activation');
                
                // Send STOP command immediately to prevent any auto-capture
                console.log('🛑 Sending initial STOP command to ensure device is in standby...');
                try {
                    const stopCommand = new Int8Array([0]); // 0 = stop any ongoing capture
                    await photoControlCharacteristic.writeValue(stopCommand);
                    console.log('✅ Device confirmed in standby mode - waiting for voice commands only');
                } catch (stopError) {
                    console.warn('⚠️ Could not send stop command, but continuing...');
                }
                
                console.log(': Setup complete');
            } catch (error) {
                console.error(': Failed to setup omiGlass service:', error);
                console.error(': This device does not support omiGlass service');
            }
        })();
    }, []);

    return [subscribed, photos] as const;
}

export const DeviceView = React.memo((props: { device: BluetoothRemoteGATTServer }) => {
    const [subscribed, photos] = usePhotos(props.device);
    const agent = React.useMemo(() => new Agent(), []);
    const agentState = agent.use();
    const [activePhotoIndex, setActivePhotoIndex] = React.useState<number | null>(null);
    const [isWaitingForResponse, setIsWaitingForResponse] = React.useState(false);
    const [lastQuestion, setLastQuestion] = React.useState<string>("");

    // Voice activation states
    const [isListening, setIsListening] = React.useState(false);
    const [isWaitingForCommand, setIsWaitingForCommand] = React.useState(false);
    const [voiceCommand, setVoiceCommand] = React.useState<string>("");
    const [recognition, setRecognition] = React.useState<any>(null);

    // Touch activation states
    const [touchActivationMode, setTouchActivationMode] = React.useState(false);
    const [isTouchWaiting, setIsTouchWaiting] = React.useState(false);
    const [touchStatusMessage, setTouchStatusMessage] = React.useState("");

    // Auto-enable touch mode when device is connected (better UX for hardware touch sensor)
    React.useEffect(() => {
        if (subscribed && !touchActivationMode) {
            console.log('👆 Auto-enabling touch activation mode for hardware touch sensor support');
            setTouchActivationMode(true);
            setTouchStatusMessage("Touch device to record until 1.5s silence");
        }
    }, [subscribed, touchActivationMode]);

    // Listen for touch audio data events
    React.useEffect(() => {
        const handleTouchAudio = (event: CustomEvent) => {
            const { audioBuffer } = event.detail;
            console.log('🎵 Received touch audio event, processing...');
            processReceivedAudio(audioBuffer);
        };

        window.addEventListener('touchAudioReceived', handleTouchAudio as EventListener);
        
        return () => {
            window.removeEventListener('touchAudioReceived', handleTouchAudio as EventListener);
        };
    }, []);

    // Initialize speech recognition
    React.useEffect(() => {
        if (typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) {
            const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
            const recognitionInstance = new SpeechRecognition();
            recognitionInstance.continuous = true;
            recognitionInstance.interimResults = false;
            recognitionInstance.lang = 'en-US';
            
            recognitionInstance.onresult = (event: any) => {
                const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase().trim();
                console.log('🎤 Voice detected:', transcript);
                
                // Handle touch activation mode
                if (touchActivationMode && isTouchWaiting) {
                    console.log('👆 Touch mode: Processing voice command:', transcript);
                    setVoiceCommand(transcript);
                    setIsTouchWaiting(false);
                    setTouchStatusMessage("Processing command...");
                    setIsListening(false);
                    recognitionInstance.stop();
                    
                    // Process the command and trigger photo capture
                    processVoiceCommand(transcript);
                    return;
                }
                
                // Handle regular voice activation mode
                if (!isWaitingForCommand) {
                    // Check for wake word
                    if (transcript.includes('lumina')) {
                        console.log('🎯 Wake word detected! Activating voice command mode...');
                        setIsWaitingForCommand(true);
                        setVoiceCommand("");
                        console.log('🎤 Wake word detected! Say your command now...');
                    }
                } else {
                    // Process voice command
                    console.log('📝 Processing voice command:', transcript);
                    setVoiceCommand(transcript);
                    setIsWaitingForCommand(false);
                    
                    // Trigger photo capture and processing with voice command
                    processVoiceCommand(transcript);
                }
            };
            
            recognitionInstance.onerror = (event: any) => {
                console.error('🚨 Speech recognition error:', event.error);
                if (event.error === 'not-allowed') {
                    console.error('❌ Microphone access denied. Please allow microphone access to use voice commands.');
                }
            };
            
            recognitionInstance.onend = () => {
                if (isListening) {
                    // Restart recognition if we're still supposed to be listening
                    recognitionInstance.start();
                }
            };
            
            setRecognition(recognitionInstance);
        } else {
            console.warn('⚠️ Speech recognition not supported in this browser');
        }
    }, [isListening]);

    // Start/stop listening
    const toggleVoiceActivation = React.useCallback(() => {
        if (!recognition) return;
        
        if (isListening) {
            recognition.stop();
            setIsListening(false);
            setIsWaitingForCommand(false);
            console.log('🛑 Voice activation stopped');
        } else {
            recognition.start();
            setIsListening(true);
            console.log('🎤 Voice activation started - say "lumina" to activate');
        }
    }, [recognition, isListening]);

    // Toggle touch activation mode
    const toggleTouchActivation = React.useCallback(() => {
        if (touchActivationMode) {
            setTouchActivationMode(false);
            setIsTouchWaiting(false);
            setTouchStatusMessage("");
            console.log('🛑 Touch activation disabled');
        } else {
            setTouchActivationMode(true);
            setTouchStatusMessage("Touch device to record until 1.5s silence");
            console.log('👆 Touch activation enabled - records until 1.5s silence + photo');
        }
    }, [touchActivationMode]);

    // Simulate touch activation (since we can't actually detect hardware touch from web)
    const simulateTouchActivation = React.useCallback(() => {
        if (!touchActivationMode) return;
        
        setIsTouchWaiting(true);
        setTouchStatusMessage("Touch detected! Speak now, will stop after 1.5s silence...");
        console.log('👆 Touch detected! Speak now - recording until 1.5s silence...');
        
        // Start voice recognition for the command (will detect speech/silence automatically)
        if (recognition && !isListening) {
            recognition.start();
            setIsListening(true);
        }
        
        // Simulate automatic silence detection (in real hardware this would be done by ESP32)
        // For web demo, we'll stop after a reasonable time or when user stops speaking
        let silenceTimer: NodeJS.Timeout;
        let lastSpeechTime = Date.now();
        
        const checkForSilence = () => {
            const timeSinceLastSpeech = Date.now() - lastSpeechTime;
            if (timeSinceLastSpeech >= 1500) { // 1.5 seconds of silence
                if (recognition && isListening) {
                    recognition.stop();
                    setIsListening(false);
                }
                
                setIsTouchWaiting(false);
                setTouchStatusMessage("Recording complete! Processing command and photo...");
                console.log('🤫 1.5s silence detected! Processing command and taking photo...');
                
                // Trigger photo capture automatically after recording
                activateOpenGlass();
                
                // Reset after processing
                setTimeout(() => {
                    setTouchStatusMessage("Ready for next touch activation");
                }, 3000);
            } else {
                silenceTimer = setTimeout(checkForSilence, 100); // Check every 100ms
            }
        };
        
        // Start monitoring for silence
        silenceTimer = setTimeout(checkForSilence, 100);
        
        // Update last speech time when speech is detected (simplified for web demo)
        const speechDetectionInterval = setInterval(() => {
            if (isListening) {
                lastSpeechTime = Date.now(); // In real implementation, this would be based on audio levels
            } else {
                clearInterval(speechDetectionInterval);
            }
        }, 200);
        
        // Maximum timeout (30 seconds safety)
        setTimeout(() => {
            if (isTouchWaiting) {
                clearTimeout(silenceTimer);
                clearInterval(speechDetectionInterval);
                setIsTouchWaiting(false);
                setTouchStatusMessage("Recording timeout. Touch again to activate.");
                console.log('⏰ Touch activation timeout');
                if (recognition && isListening) {
                    recognition.stop();
                    setIsListening(false);
                }
            }
        }, 30000);
    }, [touchActivationMode, recognition, isListening, isTouchWaiting]);

    // Process voice command with photo capture
    const processVoiceCommand = async (command: string) => {
        console.log('🗣️ Processing voice command:', command);
        console.log('🎤 VOICE WORKFLOW ACTIVATED:');
        console.log('  1. Voice command received:', command);
        console.log('  2. Now capturing fresh photo...');
        console.log('  3. Will process vision + voice together');
        
        setLastQuestion(command);
        setIsWaitingForResponse(true);
        
        console.log(`🎤 Voice command: "${command}"`);
        console.log('📸 Triggering photo capture ONLY because voice command was given...');
        
        // Clear any existing photos to ensure we get fresh data
        console.log('🧹 Clearing any old photos to ensure fresh capture...');
        
        // Trigger photo capture from glasses ONLY for voice commands
        await activateOpenGlass();
        
        // Clear voice command after processing
        setTimeout(() => setVoiceCommand(""), 5000);
        
        // Reset touch state if we were in touch mode
        if (touchActivationMode) {
            setTouchStatusMessage("Ready for next touch activation");
            setIsTouchWaiting(false);
        }
    };

    // Download function for debugging images
    const downloadImage = (imageData: Uint8Array, index: number) => {
        try {
            const blob = new Blob([new Uint8Array(imageData)], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `image_${index}.bin`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            console.log('📥 Image downloaded for inspection');
        } catch (error) {
            console.error('❌ Download failed:', error);
        }
    };

    // Simulate OpenGlass activation (like pressing the button on glasses) - ONLY for voice commands
    const activateOpenGlass = async () => {
        console.log('🔴 OpenGlass activated for voice command!');
        console.log('📷 This photo capture was triggered by voice command workflow');
        setIsWaitingForResponse(true);
        setLastQuestion("Capturing fresh photo for voice command...");
        
        // Don't process existing photos - we need fresh capture for voice command
        console.log('📱 Requesting fresh photo capture for voice command...');
        setLastQuestion("Requesting fresh photo for voice analysis...");
        
        // Reset device transmission state and request fresh capture
        try {
            const service = await props.device.getPrimaryService('19b10000-e8f2-537e-4f6c-d104768a1214');
            const photoControlCharacteristic = await service.getCharacteristic('19b10006-e8f2-537e-4f6c-d104768a1214');
            
            // STEP 1: Send stop command to reset any ongoing transmission
            console.log('🛑 Sending STOP command to reset device state...');
            const stopCommand = new Int8Array([0]); // 0 = stop capture
            await photoControlCharacteristic.writeValue(stopCommand);
            console.log('✅ STOP command sent');
            
            // Wait for device to process stop command
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // STEP 2: Send single photo capture command for voice command
            console.log('📷 Requesting fresh photo for voice command analysis...');
            const captureCommand = new Int8Array([-1]); // -1 = single photo
            await photoControlCharacteristic.writeValue(captureCommand);
            console.log('✅ Fresh photo capture requested for voice command');
            
            setLastQuestion("Capturing photo for voice command analysis...");
        } catch (error) {
            console.error('❌ Failed to send commands:', error);
            
            if (error instanceof Error) {
                if (error.name === 'NotSupportedError' || error.message.includes('GATT operation failed')) {
                    console.error('🚨 GATT operation failed - device is in unstable state');
                    console.error('💡 SOLUTION: Physical device reset required');
                    console.error('   1. Unplug USB cable from XIAO ESP32S3');
                    console.error('   2. Wait 5 seconds');
                    console.error('   3. Plug back in');
                    console.error('   4. Wait for "OMI Glass" to reconnect');
                    setLastQuestion("⚠️ Device reset required - see console for instructions");
                } else {
                    console.error('❌ Unexpected GATT error:', error.message);
                    setLastQuestion("GATT error - check console for details");
                }
            }
            
            console.log('⏳ Waiting for automatic image transmission...');
        }
        
        // The device should now send a fresh, complete JPEG starting with FF D8
    };

    // Process when we receive audio + photo data from mobile
    const processGlassesData = async () => {
        try {
            console.log('🧠 Processing data from glasses...');
            console.log('📸 Total photos available:', photos.length);
            
            // Get the latest photo for context
            const latestPhoto = photos[photos.length - 1];
            console.log('📸 Latest photo:', latestPhoto ? 'Found' : 'Not found');
            
            if (latestPhoto) {
                // Ensure the photo is added to the agent before asking questions
                console.log('📤 Adding latest photo to agent...');
                await agent.addPhoto([latestPhoto.data]);
                console.log('✅ Photo added to agent successfully');
                
                // Use voice command if available, otherwise use fallback
                const question = voiceCommand || lastQuestion || "What do you see? (very quick answer)";
                console.log('❓ Asking question:', question);
                setLastQuestion(question);
                
                console.log('🤖 Calling agent.answer...');
                const answer = await agent.answer(question);
                console.log('✅ Agent answered successfully');
                console.log('🎵 Direct answer from agent:', answer);
                
                // Play the response through desktop speakers
                if (answer) {
                    console.log('🔊 Playing TTS on desktop speakers...');
                    await textToSpeech(answer);
                    console.log('✅ TTS played on desktop speakers');
                } else {
                    console.log('⚠️ No answer returned from agent');
                }
            }
            
            console.log('🏁 Processing complete, setting isWaitingForResponse to false');
            setIsWaitingForResponse(false);
        } catch (error) {
            console.error('❌ Error processing glasses data:', error);
            setIsWaitingForResponse(false);
        }
    };

    // Process received audio from touch-activated recordings
    const processReceivedAudio = async (audioBuffer: Uint8Array[]) => {
        try {
            console.log('🎵 Processing received audio, packets:', audioBuffer.length);
             // Compute total payload length excluding 2-byte frame index per packet
             const totalLength = audioBuffer.reduce((sum, chunk) => sum + Math.max(0, chunk.length - 2), 0);
             console.log('🎵 Combined payload size (excluding headers):', totalLength, 'bytes');
            if (totalLength === 0) { console.log('⚠️ No audio data payload, using default query'); setVoiceCommand('What do you see in this image?'); return; }
            if (totalLength < 320) {
                console.warn('⚠️ Extremely short audio (<10ms) - sending anyway, may get empty transcript');
            }
             const combinedAudio = new Uint8Array(totalLength);
             let offset = 0;
             for (const chunk of audioBuffer) {
                 if (chunk.length <= 2) continue;
                 combinedAudio.set(chunk.slice(2), offset); // strip 2-byte frame index
                 offset += chunk.length - 2;
             }
             // Convert to Int16 view
             const pcmView = new Int16Array(combinedAudio.buffer, combinedAudio.byteOffset, Math.floor(combinedAudio.byteLength / 2));
             const durationMs = (pcmView.length / 16); // samples /16 = ms @16kHz
             console.log(`🎵 Prepared PCM samples=${pcmView.length} (~${durationMs.toFixed(0)}ms)`);
            if (durationMs < 100) {
                console.log('ℹ️ Very short duration (<100ms) – transcript quality may be poor');
            }
             setVoiceCommand('[transcribing touch audio...]');
             let transcript = await transcribePcm16(pcmView, 16000);
             if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
                 transcript = 'What do you see?';
             }
             transcript = transcript.trim();
             console.log('🎵 Touch audio transcript (Groq Whisper):', transcript);
             setVoiceCommand(transcript);
            if (touchActivationMode) {
                console.log('👆 Touch mode: Processing audio command and photo...');
                setIsWaitingForResponse(true);
                setTimeout(() => { if (photos.length > 0) { processGlassesData(); } else { console.log('⏳ Waiting for photo to arrive after audio...'); } }, 500);
            }
        } catch (error) {
            console.error('❌ Error processing audio:', error);
            setVoiceCommand('What do you see in this image?');
        }
    };

    // Auto-process when new photos arrive (for both voice and touch activation)
    React.useEffect(() => {
        console.log('📸 Photo effect triggered - isWaitingForResponse:', isWaitingForResponse, 'photos.length:', photos.length, 'touchActivationMode:', touchActivationMode, 'isTouchWaiting:', isTouchWaiting);
        
        // Process photos for voice commands (existing behavior)
        if (isWaitingForResponse && photos.length > 0) {
            console.log('🚀 Voice command active - processing fresh photo...');
            console.log('🎤 This photo was captured because of voice command');
            // Add small delay to prevent duplicate processing
            setTimeout(() => {
                if (isWaitingForResponse) { // Double-check state hasn't changed
                    processGlassesData();
                }
            }, 100);
        }
        // Process photos for touch activation (NEW: handle touch-activated photos)
        else if (touchActivationMode && photos.length > 0 && !isWaitingForResponse) {
            console.log('👆 Touch activation detected - processing touch-activated photo...');
            console.log('📸 This photo was captured via touch sensor activation');
            
            // For touch activation, we need to simulate having a transcript
            // Use a default question or the last transcript if available
            const touchQuery = voiceCommand || "What do you see in this image?";
            console.log('👆 Touch query:', touchQuery);
            
            // Set up state for processing
            setIsWaitingForResponse(true);
            setVoiceCommand(touchQuery);
            
            // Process immediately
            setTimeout(() => {
                processGlassesData();
            }, 100);
        }
        // Legacy: photos without activation context
        else if (photos.length > 0 && !isWaitingForResponse && !touchActivationMode) {
            console.log('⚠️ Photo received but no voice command or touch activation active - ignoring old/cached data');
            console.log('🎤 Photos should only be processed after "Lumina" wake word + voice command or touch activation');
        }
    }, [photos.length, touchActivationMode, isTouchWaiting]); // Add touch state dependencies

    // Background processing agent
    const processedPhotos = React.useRef<Uint8Array[]>([]);
    const sync = React.useMemo(() => {
        let processed = 0;
        return new InvalidateSync(async () => {
            if (processedPhotos.current.length > processed) {
                let unprocessed = processedPhotos.current.slice(processed);
                processed = processedPhotos.current.length;
                await agent.addPhoto(unprocessed);
            }
        });
    }, []);
    React.useEffect(() => {
        processedPhotos.current = photos.map(p => p.data);
        sync.invalidate();
    }, [photos]);

    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {/* Display photos in a grid filling the screen */}
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#111' }}>
                <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', padding: 5 }}>
                    {photos.slice().reverse().map((photo, index) => ( // Display newest first
                        <Pressable
                            key={photos.length - 1 - index} // Use original index for key stability if needed
                            onPressIn={() => setActivePhotoIndex(photos.length - 1 - index)}
                            onPressOut={() => setActivePhotoIndex(null)}
                            style={{
                                position: 'relative',
                                width: '33%', // Roughly 3 images per row
                                aspectRatio: 1, // Make images square
                                padding: 2 // Add spacing
                            }}
                        >
                            <Image style={{ width: '100%', height: '100%', borderRadius: 5 }} source={{ uri: toBase64Image(photo.data) }} />
                            
                            {/* Always visible download button */}
                            <View style={{
                                position: 'absolute',
                                bottom: 2,
                                left: 2,
                                right: 2,
                                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                                paddingVertical: 2,
                                paddingHorizontal: 3,
                                alignItems: 'center',
                                borderRadius: 3
                            }}>
                                <Pressable
                                    onPress={() => downloadImage(photo.data, photos.length - 1 - index)}
                                    style={{
                                        backgroundColor: '#4CAF50',
                                        paddingHorizontal: 6,
                                        paddingVertical: 2,
                                        borderRadius: 2,
                                        flexDirection: 'row',
                                        alignItems: 'center'
                                    }}
                                >
                                    <Text style={{ color: 'white', fontSize: 8 }}>📥 Download</Text>
                                </Pressable>
                            </View>
                            
                            {/* Timestamp overlay when pressed */}
                            {activePhotoIndex === (photos.length - 1 - index) && (
                                <View style={{
                                    position: 'absolute',
                                    top: 2,
                                    left: 2,
                                    right: 2,
                                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                                    paddingVertical: 2,
                                    paddingHorizontal: 5,
                                    alignItems: 'center',
                                    borderRadius: 3
                                }}>
                                    <Text style={{ color: 'white', fontSize: 9 }}>
                                        {new Date(photo.timestamp).toLocaleTimeString()}
                                    </Text>
                                </View>
                            )}
                        </Pressable>
                    ))}
                </ScrollView>
                
                {/* Connection Status Overlay - simplified to avoid stray text nodes */}
                <View style={{
                    position: 'absolute',
                    top: 50,
                    left: 20,
                    right: 20,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 15,
                    borderRadius: 10,
                    alignItems: 'center'
                }}>
                    <Text style={{ color: '#00ff00', fontSize: 16, fontWeight: 'bold' }}>
                        ✅ OpenGlass Connected
                    </Text>
                    <Text style={{ color: 'white', fontSize: 12, marginTop: 5 }}>
                        Subscribed: {subscribed ? '✅' : '❌'}
                    </Text>
                    <Text style={{ color: 'white', fontSize: 12, marginTop: 2 }}>
                        Photos received: {photos?.length || 0}
                    </Text>
                    
                    {/* OpenGlass Activation Button */}
                    <Pressable
                        onPress={activateOpenGlass}
                        disabled={isWaitingForResponse}
                        style={{
                            backgroundColor: isWaitingForResponse ? '#ff9800' : '#4CAF50',
                            padding: 15,
                            borderRadius: 25,
                            marginTop: 15,
                            minWidth: 200,
                            alignItems: 'center',
                            opacity: isWaitingForResponse ? 0.8 : 1
                        }}
                    >
                        <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}>
                            {isWaitingForResponse ? '⏳ Waiting for glasses...' : '🔴 Activate OpenGlass'}
                        </Text>
                    </Pressable>
                    
                    {/* Voice Activation Button */}
                    <Pressable
                        onPress={toggleVoiceActivation}
                        style={{
                            backgroundColor: isListening ? '#f44336' : '#2196F3',
                            padding: 12,
                            borderRadius: 25,
                            marginTop: 10,
                            minWidth: 200,
                            alignItems: 'center',
                        }}
                    >
                        <Text style={{ color: 'white', fontSize: 14, fontWeight: 'bold' }}>
                            {isListening ? '🛑 Stop Voice Activation' : '🎤 Start Voice Activation'}
                        </Text>
                        {isWaitingForCommand ? (
                            <Text style={{ color: 'white', fontSize: 12, marginTop: 5 }}>
                                💬 Listening for command...
                            </Text>
                        ) : null}
                    </Pressable>

                    {/* Touch Activation Button */}
                    <Pressable
                        onPress={toggleTouchActivation}
                        style={{
                            backgroundColor: touchActivationMode ? '#9C27B0' : '#607D8B',
                            padding: 12,
                            borderRadius: 25,
                            marginTop: 10,
                            minWidth: 200,
                            alignItems: 'center',
                        }}
                    >
                        <Text style={{ color: 'white', fontSize: 14, fontWeight: 'bold' }}>
                            {touchActivationMode ? '🛑 Disable Touch Mode' : '👆 Enable Silence Detection Mode'}
                        </Text>
                    </Pressable>

                    {/* Touch Activation Trigger (when touch mode is enabled) */}
                    {touchActivationMode ? (
                        <Pressable
                            onPress={simulateTouchActivation}
                            style={{
                                backgroundColor: isTouchWaiting ? '#ff9800' : '#4CAF50',
                                padding: 15,
                                borderRadius: 25,
                                marginTop: 10,
                                minWidth: 200,
                                alignItems: 'center',
                                opacity: isTouchWaiting ? 0.8 : 1
                            }}
                        >
                            <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}>
                                {isTouchWaiting ? '⏳ Recording until silence...' : '🔥 Touch to Record Until Silent'}
                            </Text>
                        </Pressable>
                    ) : null}
                    
                    {/* Voice status display */}
                    {(isListening || voiceCommand !== "") ? (
                        <View style={{ marginTop: 10, padding: 10, backgroundColor: '#333', borderRadius: 10 }}>
                            <Text style={{ color: 'white', fontSize: 12 }}>
                                🎤 Status: {isListening ? 'Listening for "lumina"' : 'Stopped'}
                            </Text>
                            {voiceCommand ? (
                                <Text style={{ color: '#4CAF50', fontSize: 12, marginTop: 5 }}>
                                    Last command: "{voiceCommand}"
                                </Text>
                            ) : null}
                        </View>
                    ) : null}

                    {/* Touch status display */}
                    {touchActivationMode ? (
                        <View style={{ marginTop: 10, padding: 10, backgroundColor: '#4A148C', borderRadius: 10 }}>
                            <Text style={{ color: 'white', fontSize: 12 }}>
                                👆 Touch Mode: {touchActivationMode ? 'Active' : 'Disabled'}
                            </Text>
                            {touchStatusMessage ? (
                                <Text style={{ color: '#E1BEE7', fontSize: 12, marginTop: 5 }}>
                                    Status: {touchStatusMessage}
                                </Text>
                            ) : null}
                            <Text style={{ color: '#E1BEE7', fontSize: 11, marginTop: 5, fontStyle: 'italic' }}>
                                Touch → Record until 1.5s silence → Auto photo → Processing
                            </Text>
                            <Text style={{ color: '#E1BEE7', fontSize: 11, marginTop: 2, fontStyle: 'italic' }}>
                                More accessible - speak naturally, pause when done
                            </Text>
                        </View>
                    ) : null}
                    
                    {/* Manual Process Button - for debugging */}
                    {photos.length > 0 ? (
                        <Pressable
                            onPress={() => {
                                console.log('🧪 Manual processing triggered');
                                setIsWaitingForResponse(true);
                                processGlassesData();
                            }}
                            style={{
                                backgroundColor: '#2196F3',
                                padding: 10,
                                borderRadius: 20,
                                marginTop: 10,
                                minWidth: 180,
                                alignItems: 'center'
                            }}
                        >
                            <Text style={{ color: 'white', fontSize: 14, fontWeight: 'bold' }}>
                                🧪 Process Latest Image ({photos.length} available)
                            </Text>
                        </Pressable>
                    ) : null}
                    
                    {/* Device Reset Button - for transmission issues */}
                    <Pressable
                        onPress={async () => {
                            console.log('🔄 Device reset triggered');
                            try {
                                const service = await props.device.getPrimaryService('19b10000-e8f2-537e-4f6c-d104768a1214');
                                const photoControlCharacteristic = await service.getCharacteristic('19b10006-e8f2-537e-4f6c-d104768a1214');
                                
                                console.log('🛑 Sending STOP command...');
                                const stopCommand = new Int8Array([0]);
                                await photoControlCharacteristic.writeValue(stopCommand);
                                console.log('✅ Device transmission stopped');
                                console.log('💡 Device should reset and be ready for fresh capture');
                            } catch (error) {
                                console.error('❌ Reset failed:', error);
                            }
                        }}
                        style={{
                            backgroundColor: '#FF5722',
                            padding: 10,
                            borderRadius: 20,
                            marginTop: 10,
                            minWidth: 180,
                            alignItems: 'center'
                        }}
                    >
                        <Text style={{ color: 'white', fontSize: 14, fontWeight: 'bold' }}>
                            🔄 Reset Device Transmission
                        </Text>
                    </Pressable>
                    
                    {/* Device Reset Instructions - when GATT fails */}
                    {lastQuestion?.includes("Device reset required") ? (
                        <View style={{
                            marginTop: 15,
                            padding: 15,
                            backgroundColor: 'rgba(255, 87, 34, 0.2)',
                            borderRadius: 10,
                            borderLeftWidth: 4,
                            borderLeftColor: '#FF5722'
                        }}>
                            <Text style={{ color: '#FF5722', fontSize: 14, fontWeight: 'bold' }}>
                                🚨 Hardware Reset Required
                            </Text>
                            <Text style={{ color: 'white', fontSize: 12, marginTop: 8 }}>
                                Device is in unstable state. Please:
                            </Text>
                            <Text style={{ color: 'white', fontSize: 11, marginTop: 5 }}>
                                1. Unplug USB cable from XIAO ESP32S3
                            </Text>
                            <Text style={{ color: 'white', fontSize: 11 }}>
                                2. Wait 5 seconds
                            </Text>
                            <Text style={{ color: 'white', fontSize: 11 }}>
                                3. Plug back in
                            </Text>
                            <Text style={{ color: 'white', fontSize: 11 }}>
                                4. Wait for "OMI Glass" to reconnect
                            </Text>
                        </View>
                    ) : null}
                    
                    {/* Current Status */}
                    {lastQuestion !== "" && !lastQuestion.includes("Device reset required") ? (
                        <View style={{
                            marginTop: 10,
                            padding: 8,
                            backgroundColor: 'rgba(255, 152, 0, 0.2)',
                            borderRadius: 8,
                            borderLeftWidth: 3,
                            borderLeftColor: '#ff9800'
                        }}>
                            <Text style={{ color: '#ff9800', fontSize: 11, fontWeight: 'bold' }}>
                                🎤 Last Question:
                            </Text>
                            <Text style={{ color: 'white', fontSize: 10, marginTop: 3 }}>
                                {String(lastQuestion || '')}
                            </Text>
                        </View>
                    ) : null}
                    
                    
                   
                    
                    {/* AI Response Display */}
                    {agentState?.answer && agentState.answer !== "" ? (
                        <View style={{
                            marginTop: 15,
                            padding: 10,
                            backgroundColor: 'rgba(76, 175, 80, 0.2)',
                            borderRadius: 10,
                            borderLeftWidth: 3,
                            borderLeftColor: '#4CAF50'
                        }}>
                            <Text style={{ color: '#4CAF50', fontSize: 12, fontWeight: 'bold' }}>
                                🤖 OpenGlass Response:
                            </Text>
                            <Text style={{ color: 'white', fontSize: 11, marginTop: 5 }}>
                                {String(agentState.answer || '')}
                            </Text>
                        </View>
                    ) : null}
                    
                    <Text style={{ color: '#ffa500', fontSize: 10, marginTop: 8, textAlign: 'center' }}>
                        {(photos?.length || 0) === 0 ? 'Tap "Activate OpenGlass" to start...' : 'Voice + Vision AI ready!'}
                    </Text>
                </View>
            </View>
        </View>
    );
});