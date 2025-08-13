import * as React from 'react';

const DEVICE_STORAGE_KEY = 'openglassDeviceId';

export function useDevice(): [BluetoothRemoteGATTServer | null, () => Promise<void>, boolean] {

    // Check Web Bluetooth support
    React.useEffect(() => {
        if (!navigator.bluetooth) {
            console.error('Web Bluetooth is not supported on this browser');
            console.error('Supported browsers: Chrome/Edge 56+, Opera 43+');
            console.error('Requires HTTPS and secure context');
            return;
        }
        
        navigator.bluetooth.getAvailability().then(available => {
            if (available) {
                console.log('Bluetooth is available');
            } else {
                console.error('Bluetooth is not available on this device');
            }
        }).catch(err => {
            console.error('Error checking Bluetooth availability:', err);
        });
    }, []);

    // Create state
    let deviceRef = React.useRef<BluetoothRemoteGATTServer | null>(null);
    let [device, setDevice] = React.useState<BluetoothRemoteGATTServer | null>(null);
    let [isAutoConnecting, setIsAutoConnecting] = React.useState<boolean>(false);

    // Setup disconnect handler
    const setupDisconnectHandler = (connectedDevice: BluetoothDevice) => {
        connectedDevice.ongattserverdisconnected = async () => {
            console.log('Device disconnected, attempting to reconnect...');
            
            // Attempt to reconnect
            setIsAutoConnecting(true);
            try {
                if (connectedDevice.gatt) {
                    const gatt = await connectedDevice.gatt.connect();
                    deviceRef.current = gatt;
                    setDevice(gatt);
                    console.log('Reconnection successful!');
                }
            } catch (err) {
                console.error('Reconnection failed:', err);
                deviceRef.current = null;
                setDevice(null);
            } finally {
                setIsAutoConnecting(false);
            }
        };
    };

    // Create callback
    const doConnect = React.useCallback(async () => {
        try {
            console.log('=== Starting Bluetooth Device Scan ===');
            console.log('Looking for OpenGlass device with service: 19b10000-e8f2-537e-4f6c-d104768a1214');
            
            // First try to find OpenGlass specifically
            console.log('Attempt 1: Searching specifically for OpenGlass service...');
            try {
                let specificDevice = await navigator.bluetooth.requestDevice({
                    filters: [{
                        services: ['19b10000-e8f2-537e-4f6c-d104768a1214']
                    }]
                });
                console.log('✅ Found OpenGlass device specifically:', specificDevice.name || 'Unnamed OpenGlass Device');
                
                // Automatically connect to the OpenGlass device if found
                const gatt = await specificDevice.gatt!.connect();
                console.log('✅ Auto-connected to OpenGlass device!');
                deviceRef.current = gatt;
                setDevice(gatt);
                setupDisconnectHandler(specificDevice);
                return;
                
            } catch (specificError) {
                console.log('❌ Specific OpenGlass search failed:', specificError);
                console.log('User may have cancelled or device not advertising properly');
                console.log('Falling back to general device scan...');
            }
            
            // Fallback: Show all devices for manual selection
            console.log('Attempt 2: Showing all available devices...');
            let connected = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: [
                    'battery_service',
                    'device_information',
                    'generic_access',
                    'generic_attribute',
                    '19b10000-e8f2-537e-4f6c-d104768a1214', // Original OpenGlass service
                    '0000180f-0000-1000-8000-00805f9b34fb', // Battery Service
                    '0000180a-0000-1000-8000-00805f9b34fb', // Device Information Service
                    '00001800-0000-1000-8000-00805f9b34fb', // Generic Access
                    '00001801-0000-1000-8000-00805f9b34fb', // Generic Attribute
                    // Add more common services that mobile devices might advertise
                    '0000181a-0000-1000-8000-00805f9b34fb', // Environmental Sensing
                    '0000181c-0000-1000-8000-00805f9b34fb', // User Data
                    '0000181d-0000-1000-8000-00805f9b34fb', // Weight Scale
                ],
            });

            // Store device ID for future reconnections
            console.log('=== Device Selected ===');
            console.log('Device ID:', connected.id);
            console.log('Device Name:', connected.name || 'No name provided');
            console.log('GATT Available:', !!connected.gatt);
            
            // Check if this might be your OpenGlass device
            if (connected.name && connected.name.toLowerCase().includes('openglass')) {
                console.log('🎉 This appears to be your OpenGlass device!');
            } else if (!connected.name) {
                console.log('⚠️ Device has no name - could be your OpenGlass device');
            } else {
                console.log('📱 Selected device:', connected.name);
            }
            
            console.log('Device info:', {
                id: connected.id,
                name: connected.name || 'No name',
                gatt: connected.gatt?.connected
            });
            localStorage.setItem(DEVICE_STORAGE_KEY, connected.id);

            // Check if device supports GATT
            if (!connected.gatt) {
                throw new Error('Device does not support GATT');
            }

            // Connect to gatt
            console.log('Connecting to GATT server...');
            let gatt: BluetoothRemoteGATTServer = await connected.gatt.connect();
            console.log('Connected successfully!');
            console.log('GATT server:', {
                connected: gatt.connected,
                device: gatt.device.name || 'Unnamed device'
            });

            // Update state
            deviceRef.current = gatt;
            setDevice(gatt);
            console.log('Device state updated, should show interface now');
            
            // Setup disconnect handler for auto-reconnect
            setupDisconnectHandler(connected);
            
        } catch (e) {
            // Handle error
            console.error('Connection failed:', e);
            
            // Provide more specific error information
            if (e instanceof Error) {
                if (e.name === 'NotFoundError') {
                    console.error('No Bluetooth devices found. Make sure your device is:');
                    console.error('1. Bluetooth LE enabled');
                    console.error('2. In discoverable/pairing mode');
                    console.error('3. Advertising Bluetooth LE services');
                    console.error('4. Within range of your computer');
                } else if (e.name === 'SecurityError') {
                    console.error('Web Bluetooth requires HTTPS and user gesture');
                } else if (e.name === 'NotSupportedError') {
                    console.error('Web Bluetooth is not supported on this browser/platform');
                }
            }
        }
    }, []);

    // Return
    return [device, doConnect, isAutoConnecting];
}