// Bluetooth Test Utilities
export async function testWebBluetoothSupport(): Promise<void> {
    console.log('=== Web Bluetooth Support Test ===');
    
    // Check if Web Bluetooth is available
    if (!navigator.bluetooth) {
        console.error('❌ Web Bluetooth is not supported');
        return;
    }
    console.log('✅ Web Bluetooth API is available');
    
    try {
        // Check Bluetooth availability
        const isAvailable = await navigator.bluetooth.getAvailability();
        if (isAvailable) {
            console.log('✅ Bluetooth adapter is available');
        } else {
            console.log('❌ Bluetooth adapter is not available');
        }
    } catch (error) {
        console.error('❌ Error checking Bluetooth availability:', error);
    }
}

export async function scanForAnyBLEDevice(): Promise<void> {
    console.log('=== Scanning for ANY BLE device ===');
    
    try {
        const device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [] // No services required
        });
        
        console.log('✅ Found device:', {
            name: device.name || 'Unnamed device',
            id: device.id
        });
        
        // Try to connect
        if (device.gatt) {
            console.log('Attempting to connect to GATT server...');
            const server = await device.gatt.connect();
            console.log('✅ Connected to GATT server');
            
            // Get available services
            try {
                const services = await server.getPrimaryServices();
                console.log('Available services:', services.map(s => s.uuid));
            } catch (e) {
                console.log('Could not enumerate services:', e);
            }
            
            // Disconnect
            device.gatt.disconnect();
            console.log('Disconnected from device');
        }
        
    } catch (error) {
        console.error('❌ Scan failed:', error);
        if (error instanceof Error) {
            if (error.name === 'NotFoundError') {
                console.log('💡 No devices found. Try:');
                console.log('   - Ensure your device is in pairing/discoverable mode');
                console.log('   - Make sure Bluetooth LE is enabled');
                console.log('   - Check if device is advertising services');
            }
        }
    }
}

// Test with specific service filter
export async function testWithServiceFilter(serviceUuid: string): Promise<void> {
    console.log(`=== Testing with service filter: ${serviceUuid} ===`);
    
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{
                services: [serviceUuid]
            }]
        });
        
        console.log('✅ Found device with service:', {
            name: device.name || 'Unnamed device',
            id: device.id
        });
        
    } catch (error) {
        console.error('❌ Service filter test failed:', error);
    }
}
