import * as React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { rotateImage } from '../modules/imaging';
import { toBase64Image } from '../utils/base64';
import { Agent } from '../agent/Agent';
import { InvalidateSync } from '../utils/invalidateSync';
import { textToSpeech } from '../modules/groq';

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
            }

            try {
                console.log('DeviceView: Trying to get omiGlass service...');
                // Subscribe for photo updates
                const service = await device.getPrimaryService('19B10000-E8F2-537E-4F6C-D104768A1214'.toLowerCase());
                console.log('DeviceView: Got service successfully');
                
                console.log('DeviceView: Getting photo data characteristic...');
                const photoCharacteristic = await service.getCharacteristic('19b10005-e8f2-537e-4f6c-d104768a1214');
                console.log('DeviceView: Got photo data characteristic:', photoCharacteristic);
                
                console.log('DeviceView: Starting notifications...');
                await photoCharacteristic.startNotifications();
                console.log('DeviceView: Notifications started successfully');
                console.log('DeviceView: Checking notification properties:', {
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
                
                console.log('DeviceView: Getting photo control characteristic...');
                const photoControlCharacteristic = await service.getCharacteristic('19b10006-e8f2-537e-4f6c-d104768a1214');
                console.log('DeviceView: Got photo control characteristic:', photoControlCharacteristic);
                
                console.log('DeviceView: Writing to photo control characteristic...');
                await photoControlCharacteristic.writeValue(new Uint8Array([0x05]));
                console.log('DeviceView: Write operation successful');
                
                console.log('DeviceView: Setup complete');
            } catch (error) {
                console.error('DeviceView: Failed to setup omiGlass service:', error);
                console.error('DeviceView: This device does not support omiGlass service');
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
    const [audioOutputMode, setAudioOutputMode] = React.useState<'mobile' | 'desktop'>('mobile');

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

    // Simulate OpenGlass activation (like pressing the button on glasses)
    const activateOpenGlass = async () => {
        console.log('🔴 OpenGlass activated!');
        setIsWaitingForResponse(true);
        
        // Send activation command to mobile (glasses)
        try {
            const service = await props.device.getPrimaryService('19b10000-e8f2-537e-4f6c-d104768a1214');
            const photoControlCharacteristic = await service.getCharacteristic('19b10006-e8f2-537e-4f6c-d104768a1214');
            
            // Send activation command (0x10 = start recording + photo capture)
            await photoControlCharacteristic.writeValue(new Uint8Array([0x10])); 
            console.log('📱 Activation command sent to mobile (glasses)');
            setLastQuestion("Waiting for audio from glasses...");
            
            // EXPERIMENTAL: Try to request higher quality image
            console.log('🧪 EXPERIMENTAL: Requesting high-quality image...');
            setTimeout(async () => {
                try {
                    // Try different command codes to see if device supports quality settings
                    await photoControlCharacteristic.writeValue(new Uint8Array([0x11])); // Alternative command
                    console.log('🧪 Alternative image quality command sent');
                } catch (error) {
                    console.log('🧪 Alternative command failed (expected):', error);
                }
            }, 100);
            
        } catch (error) {
            console.error('❌ Error sending activation command:', error);
            setIsWaitingForResponse(false);
        }
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
                
                // For now, simulate a question - in real implementation, 
                // audio would be transcribed from mobile
                const simulatedQuestion = "What do you see? (very quick answer)";
                console.log('❓ Asking question:', simulatedQuestion);
                setLastQuestion(simulatedQuestion);
                
                console.log('🤖 Calling agent.answer...');
                const answer = await agent.answer(simulatedQuestion);
                console.log('✅ Agent answered successfully');
                console.log('🎵 Direct answer from agent:', answer);
                
                // Play the response through chosen output
                if (answer) {
                    if (audioOutputMode === 'mobile') {
                        console.log('🔊 Sending TTS to mobile device...');
                        await sendAudioToDevice(answer);
                        console.log('✅ TTS sent to mobile device');
                    } else {
                        console.log('🔊 Playing TTS on desktop...');
                        await textToSpeech(answer);
                        console.log('✅ Desktop TTS completed');
                    }
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

    // Send audio data to mobile device via Bluetooth
    const sendAudioToDevice = async (text: string) => {
        try {
            console.log('🎵 Generating TTS audio for mobile device...');
            
            // Get TTS audio data from Groq (but don't play it)
            const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.EXPO_PUBLIC_GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: "playai-tts-arabic",
                    voice: "Ahmad-PlayAI", 
                    response_format: "wav",
                    input: text,
                })
            });

            if (!response.ok) {
                throw new Error(`TTS API failed: ${response.status}`);
            }

            const audioArrayBuffer = await response.arrayBuffer();
            const audioData = new Uint8Array(audioArrayBuffer);
            console.log('✅ TTS audio generated:', audioData.length, 'bytes');

            // Get the Bluetooth service and speaker characteristic
            const service = await props.device.getPrimaryService('19b10000-e8f2-537e-4f6c-d104768a1214');
            
            // DISCOVER ALL AVAILABLE CHARACTERISTICS
            console.log('🔍 Discovering all available characteristics...');
            const allCharacteristics = await service.getCharacteristics();
            console.log('📋 Available characteristics:');
            allCharacteristics.forEach((char, index) => {
                console.log(`  ${index + 1}. UUID: ${char.uuid}`);
                console.log(`     Properties: write=${char.properties.write}, read=${char.properties.read}, notify=${char.properties.notify}`);
            });
            
            // Try to find speaker characteristic
            let speakerCharacteristic;
            try {
                speakerCharacteristic = await service.getCharacteristic('19b10003-e8f2-537e-4f6c-d104768a1214');
                console.log('✅ Found speaker characteristic: 19b10003');
            } catch (error) {
                console.log('❌ Speaker characteristic 19b10003 not found');
                
                // Try alternative UUIDs that might be speaker-related
                const alternativeUUIDs = [
                    '19b10004-e8f2-537e-4f6c-d104768a1214',
                    '19b10007-e8f2-537e-4f6c-d104768a1214',
                    'cab1ab95-2ea5-4f4d-bb56-874b72cfc984', // From firmware speaker service
                    'cab1ab96-2ea5-4f4d-bb56-874b72cfc984'  // Speaker haptic characteristic
                ];
                
                for (const uuid of alternativeUUIDs) {
                    try {
                        const altChar = await service.getCharacteristic(uuid);
                        console.log(`✅ Found alternative characteristic: ${uuid}`);
                        if (altChar.properties.write) {
                            console.log(`🎯 Using ${uuid} as speaker characteristic (has write property)`);
                            speakerCharacteristic = altChar;
                            break;
                        }
                    } catch (e) {
                        console.log(`❌ Alternative UUID ${uuid} not found`);
                    }
                }
            }
            
            if (!speakerCharacteristic) {
                throw new Error('No speaker characteristic found - device may not support audio output');
            }
            
            console.log('📱 Found speaker characteristic:', speakerCharacteristic.uuid);

            // Send audio data in chunks (Bluetooth has MTU limitations)
            const chunkSize = 400; // Max chunk size for audio packets based on firmware
            const totalPackets = Math.ceil(audioData.length / chunkSize);
            let offset = 0;
            let packetNumber = 0;

            console.log('📤 Audio transmission plan:');
            console.log(`   Total audio size: ${audioData.length.toLocaleString()} bytes`);
            console.log(`   Chunk size: ${chunkSize} bytes`);
            console.log(`   Total packets: ${totalPackets.toLocaleString()}`);
            console.log(`   Estimated time: ~${Math.ceil(totalPackets * 0.01)} seconds`);
            console.log('📤 Starting transmission...');

            while (offset < audioData.length) {
                const chunk = audioData.slice(offset, offset + chunkSize);
                
                // Create packet with header (similar to how device sends audio to us)
                const packet = new Uint8Array(chunk.length + 3);
                packet[0] = packetNumber & 0xFF;         // Packet number low byte
                packet[1] = (packetNumber >> 8) & 0xFF;  // Packet number high byte  
                packet[2] = 0;                           // Chunk index within packet
                packet.set(chunk, 3);                    // Audio data

                await speakerCharacteristic.writeValue(packet);
                
                // Progress indicator every 100 packets
                if (packetNumber % 100 === 0 || packetNumber === totalPackets - 1) {
                    const progress = Math.round((packetNumber / totalPackets) * 100);
                    console.log(`📦 Progress: ${packetNumber + 1}/${totalPackets} packets (${progress}%)`);
                }
                
                offset += chunkSize;
                packetNumber++;

                // Small delay to avoid overwhelming the device
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            // Send end marker to signal audio transmission complete
            const endMarker = new Uint8Array([0xFF, 0xFF]);
            await speakerCharacteristic.writeValue(endMarker);
            console.log('🏁 Audio transmission complete - end marker sent');

        } catch (error) {
            console.error('❌ Error sending audio to device:', error);
            // Fallback to desktop audio if mobile transmission fails
            console.log('🔄 Falling back to desktop audio playback...');
            try {
                await textToSpeech(text);
                console.log('✅ Desktop fallback audio completed');
            } catch (fallbackError) {
                console.error('❌ Desktop fallback also failed:', fallbackError);
            }
        }
    };

    // Auto-process when new photos arrive (simulating audio+photo from glasses)
    React.useEffect(() => {
        console.log('📸 Photo effect triggered - isWaitingForResponse:', isWaitingForResponse, 'photos.length:', photos.length);
        if (isWaitingForResponse && photos.length > 0) {
            console.log('🚀 Auto-triggering processGlassesData...');
            processGlassesData();
        }
    }, [photos.length, isWaitingForResponse]);

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
                    
                    {/* Current Status */}
                    {lastQuestion ? (
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
                    {agentState?.answer ? (
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