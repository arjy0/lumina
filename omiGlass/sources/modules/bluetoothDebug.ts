// Test function to help debug OpenGlass device visibility
export async function debugOpenGlassDevice() {
    console.log('=== OpenGlass Device Debug ===');
    
    if (!navigator.bluetooth) {
        console.error('❌ Web Bluetooth not supported');
        return;
    }
    
    // Test 1: Check for specific OpenGlass service
    console.log('Test 1: Looking for OpenGlass service specifically...');
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{
                services: ['19b10000-e8f2-537e-4f6c-d104768a1214']
            }]
        });
        console.log('✅ Found OpenGlass service device:', device.name || 'Unnamed');
        
        // If device was found, try to connect and return it
        if (device.gatt) {
            console.log('🔗 Attempting to connect to OpenGlass device...');
            try {
                const server = await device.gatt.connect();
                console.log('✅ Successfully connected to OpenGlass device!');
                console.log('Device details:', {
                    name: device.name || 'No name provided',
                    id: device.id,
                    connected: server.connected
                });
                
                // Don't disconnect yet - let user see the connection worked
                console.log('🎉 This is your OpenGlass device! Keeping connection open...');
                return device;
            } catch (connectError) {
                console.error('❌ Failed to connect to OpenGlass device:', (connectError as Error).message || connectError);
            }
        }
        
        return device;
    } catch (error) {
        console.log('❌ OpenGlass service not found:', (error as Error).message || error);
    }
    
    // Test 2: Look for device by name
    console.log('Test 2: Looking for devices named "OpenGlass"...');
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{
                name: 'OpenGlass'
            }],
            optionalServices: ['19b10000-e8f2-537e-4f6c-d104768a1214']
        });
        console.log('✅ Found OpenGlass by name:', device.name);
        return device;
    } catch (error) {
        console.log('❌ OpenGlass name not found:', (error as Error).message || error);
    }
    
    // Test 3: Look for devices with name prefix
    console.log('Test 3: Looking for devices with "Open" prefix...');
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{
                namePrefix: 'Open'
            }],
            optionalServices: ['19b10000-e8f2-537e-4f6c-d104768a1214']
        });
        console.log('✅ Found device with "Open" prefix:', device.name);
        return device;
    } catch (error) {
        console.log('❌ No devices with "Open" prefix found:', (error as Error).message || error);
    }
    
    console.log('❌ OpenGlass device not found in any test');
    console.log('💡 Suggestions:');
    console.log('   1. Make sure your mobile BLE app is actually advertising (not just configured)');
    console.log('   2. Check that the service UUID is included in the advertisement packet');
    console.log('   3. Ensure the device name "OpenGlass" is being advertised');
    console.log('   4. Verify your mobile device is in discoverable mode');
    console.log('   5. Try restarting the BLE app on your mobile device');
}

// Helper function to scan and analyze all nearby devices
export async function analyzeNearbyDevices() {
    console.log('=== Analyzing All Nearby BLE Devices ===');
    
    try {
        const device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: []
        });
        
        console.log('Selected device for analysis:');
        console.log('Name:', device.name || 'No name');
        console.log('ID:', device.id);
        
        if (device.gatt) {
            console.log('Attempting to connect and analyze services...');
            try {
                const server = await device.gatt.connect();
                const services = await server.getPrimaryServices();
                
                console.log('Available services:');
                services.forEach((service, index) => {
                    console.log(`  ${index + 1}. ${service.uuid}`);
                    
                    // Check if this is the OpenGlass service
                    if (service.uuid === '19b10000-e8f2-537e-4f6c-d104768a1214') {
                        console.log('🎉 Found OpenGlass service on this device!');
                    }
                });
                
                device.gatt.disconnect();
            } catch (connectError) {
                console.log('Could not connect to device:', (connectError as Error).message || connectError);
            }
        }
        
    } catch (error) {
        console.log('Device selection cancelled or failed:', (error as Error).message || error);
    }
}
