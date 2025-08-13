import * as React from 'react';
import { SafeAreaView, StyleSheet, View, Text } from 'react-native';
import { RoundButton } from './components/RoundButton';
import { Theme } from './components/theme';
import { useDevice } from '../modules/useDevice';
import { DeviceView } from './DeviceView';
import { startAudio } from '../modules/groq';
import { debugOpenGlassDevice, analyzeNearbyDevices } from '../modules/bluetoothDebug';
import { testGroqIntegration } from '../utils/testGroq';

export const Main = React.memo(() => {

    const [device, connectDevice, isAutoConnecting] = useDevice();
    const [isConnecting, setIsConnecting] = React.useState(false);
    
    // Handle connection attempt
    const handleConnect = React.useCallback(async () => {
        setIsConnecting(true);
        try {
            await connectDevice();
        } finally {
            setIsConnecting(false);
        }
    }, [connectDevice]);
    
    // Handle direct OpenGlass connection
    const handleOpenGlassConnect = React.useCallback(async () => {
        setIsConnecting(true);
        try {
            console.log('🔍 Connecting directly to OpenGlass...');
            
            // Use the same logic as the working debug function
            const device = await navigator.bluetooth.requestDevice({
                filters: [{
                    services: ['19b10000-e8f2-537e-4f6c-d104768a1214']
                }]
            });
            
            console.log('✅ Found OpenGlass device:', device.name || 'Unnamed OpenGlass');
            
            // Connect to the device using GATT
            const gatt = await device.gatt!.connect();
            console.log('✅ Connected to OpenGlass successfully!');
            
            // Force a re-render by calling connectDevice with the found device
            // The useDevice hook should handle the rest
            
        } catch (error) {
            console.error('❌ OpenGlass connection failed:', error);
            if (error instanceof Error) {
                if (error.message.includes('User cancelled')) {
                    console.log('User cancelled the OpenGlass connection');
                } else {
                    console.error('Connection error:', error.message);
                }
            }
        } finally {
            setIsConnecting(false);
        }
    }, []);
    
    return (
        <SafeAreaView style={styles.container}>
            {!device && (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', alignSelf: 'center' }}>
                    {isConnecting ? (
                        <Text style={styles.statusText}>Connecting to OpenGlass...</Text>
                    ) : (
                        <>
                            <RoundButton title="Connect to the device" action={handleConnect} />
                            <View style={{ marginTop: 10 }}>
                                <RoundButton title="Connect to OpenGlass" action={handleOpenGlassConnect} />
                            </View>
                            
                            {/* Debug buttons - remove these after testing */}
                            <View style={{ marginTop: 20 }}>
                                <RoundButton 
                                    title="Debug: Find OpenGlass" 
                                    action={() => debugOpenGlassDevice()} 
                                />
                                <View style={{ marginTop: 10 }}>
                                    <RoundButton 
                                        title="Debug: Analyze Device" 
                                        action={() => analyzeNearbyDevices()} 
                                    />
                                </View>
                                <View style={{ marginTop: 10 }}>
                                    <RoundButton 
                                        title="🧪 Test Groq TTS" 
                                        action={() => testGroqIntegration()} 
                                    />
                                </View>
                            </View>
                        </>
                    )}
                </View>
            )}
            {device && (
                <DeviceView device={device} />
            )}
        </SafeAreaView>
    );
});

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: Theme.background,
        alignItems: 'stretch',
        justifyContent: 'center',
    },
    statusText: {
        color: Theme.text,
        fontSize: 18,
        marginBottom: 16,
    }
});