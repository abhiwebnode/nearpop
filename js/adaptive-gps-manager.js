// ╔══════════════════════════════════════════════════════════════════╗
// ║  Adaptive GPS Manager v2.0 - Production Ready                    ║
// ║  Battery-optimized location tracking with movement detection      ║
// ║  Replace GPS code in map.html (lines ~1311-1385)                 ║
// ╚══════════════════════════════════════════════════════════════════╝

class AdaptiveGPSManager {
    constructor() {
        // GPS settings
        this.watchId = null;
        this.lastProcLat = null;
        this.lastProcLng = null;
        this.currentAccuracy = null;
        
        // Movement detection
        this.positions = []; // Last 5 positions for movement analysis
        this.maxPositionHistory = 5;
        this.isStationary = false;
        this.speed = 0; // meters per second
        
        // Adaptive thresholds
        this.MIN_MOVE_M = 10; // Only process if moved 10m+
        this.STATIONARY_THRESHOLD = 5; // <5m movement = stationary
        this.STATIONARY_TIME_MS = 60000; // 1 minute stationary = reduce GPS
        this.stationaryStartTime = null;
        
        // GPS modes
        this.mode = 'high'; // 'high', 'medium', 'low'
        
        // Callbacks
        this.onPositionCallback = null;
        this.onMovementChangeCallback = null;
    }

    // ═══════════════════════════════════════════════════════════════
    // START GPS TRACKING
    // ═══════════════════════════════════════════════════════════════
    start(onPosition, onMovementChange = null) {
        if (!navigator.geolocation) {
            console.warn('[GPS] Geolocation not available');
            return false;
        }

        this.onPositionCallback = onPosition;
        this.onMovementChangeCallback = onMovementChange;

        // Initial high-accuracy position
        navigator.geolocation.getCurrentPosition(
            p => this._handlePosition(p, true),
            err => this._handleError(err),
            {
                enableHighAccuracy: true,
                timeout: 12000,
                maximumAge: 0
            }
        );

        // Start watching with adaptive settings
        this._startWatchWithMode('high');

        console.log('[GPS] Adaptive tracking started');
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // STOP GPS TRACKING
    // ═══════════════════════════════════════════════════════════════
    stop() {
        if (this.watchId !== null) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
            console.log('[GPS] Tracking stopped');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // START WATCH WITH SPECIFIC MODE
    // ═══════════════════════════════════════════════════════════════
    _startWatchWithMode(mode) {
        // Clear existing watch
        if (this.watchId !== null) {
            navigator.geolocation.clearWatch(this.watchId);
        }

        this.mode = mode;

        // Mode-specific settings for battery optimization
        const settings = {
            'high': {
                enableHighAccuracy: true,
                maximumAge: 5000,      // Accept cache up to 5s old
                timeout: 10000
            },
            'medium': {
                enableHighAccuracy: false,
                maximumAge: 15000,     // Accept cache up to 15s old
                timeout: 15000
            },
            'low': {
                enableHighAccuracy: false,
                maximumAge: 30000,     // Accept cache up to 30s old
                timeout: 20000
            }
        };

        const config = settings[mode];

        this.watchId = navigator.geolocation.watchPosition(
            p => this._handlePosition(p, false),
            err => this._handleError(err),
            config
        );

        console.log(`[GPS] Watch started in ${mode} mode`, config);
    }

    // ═══════════════════════════════════════════════════════════════
    // HANDLE GPS POSITION
    // ═══════════════════════════════════════════════════════════════
    _handlePosition(position, forceProcess = false) {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;
        const timestamp = position.timestamp;

        this.currentAccuracy = accuracy;

        // Add to position history
        this.positions.push({
            lat,
            lng,
            accuracy,
            timestamp
        });

        // Keep only last N positions
        if (this.positions.length > this.maxPositionHistory) {
            this.positions.shift();
        }

        // Analyze movement
        const movementAnalysis = this._analyzeMovement();
        
        // Update stationary state
        const wasStationary = this.isStationary;
        this.isStationary = movementAnalysis.isStationary;
        this.speed = movementAnalysis.speed;

        // Notify movement change
        if (wasStationary !== this.isStationary && this.onMovementChangeCallback) {
            this.onMovementChangeCallback({
                isStationary: this.isStationary,
                speed: this.speed,
                mode: this.mode
            });
        }

        // Adaptive GPS mode switching
        this._adaptGPSMode(movementAnalysis);

        // Check if we should process this position
        const shouldProcess = forceProcess || this._shouldProcessPosition(lat, lng);

        if (!shouldProcess) {
            console.log('[GPS] Position update skipped (< 10m movement)');
            return;
        }

        // Update last processed position
        this.lastProcLat = lat;
        this.lastProcLng = lng;

        // Callback with position and movement context
        if (this.onPositionCallback) {
            this.onPositionCallback(position, {
                isStationary: this.isStationary,
                speed: this.speed,
                accuracy,
                mode: this.mode,
                densityLevel: this._estimateDensityLevel()
            });
        }

        console.log('[GPS] Position processed:', {
            lat: lat.toFixed(6),
            lng: lng.toFixed(6),
            accuracy: Math.round(accuracy),
            isStationary: this.isStationary,
            speed: this.speed.toFixed(2),
            mode: this.mode
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // ANALYZE MOVEMENT FROM POSITION HISTORY
    // ═══════════════════════════════════════════════════════════════
    _analyzeMovement() {
        if (this.positions.length < 2) {
            return { isStationary: false, speed: 0, totalDistance: 0 };
        }

        // Calculate total distance and time
        let totalDistance = 0;
        const positions = this.positions;

        for (let i = 1; i < positions.length; i++) {
            const dist = this._gpsDistM(
                positions[i-1].lat,
                positions[i-1].lng,
                positions[i].lat,
                positions[i].lng
            );
            totalDistance += dist;
        }

        const timeSpan = positions[positions.length - 1].timestamp - positions[0].timestamp;
        const timeSpanSeconds = timeSpan / 1000;

        // Calculate speed (m/s)
        const speed = timeSpanSeconds > 0 ? totalDistance / timeSpanSeconds : 0;

        // Determine if stationary (< 5m movement in last minute)
        const isStationary = totalDistance < this.STATIONARY_THRESHOLD;

        return {
            isStationary,
            speed,
            totalDistance
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // SHOULD WE PROCESS THIS POSITION?
    // ═══════════════════════════════════════════════════════════════
    _shouldProcessPosition(lat, lng) {
        if (this.lastProcLat === null || this.lastProcLng === null) {
            return true; // First position, always process
        }

        const moved = this._gpsDistM(lat, lng, this.lastProcLat, this.lastProcLng);
        return moved >= this.MIN_MOVE_M;
    }

    // ═══════════════════════════════════════════════════════════════
    // ADAPTIVE GPS MODE SWITCHING (BATTERY OPTIMIZATION)
    // ═══════════════════════════════════════════════════════════════
    _adaptGPSMode(movementAnalysis) {
        const { isStationary, speed } = movementAnalysis;

        // Track stationary time
        if (isStationary) {
            if (!this.stationaryStartTime) {
                this.stationaryStartTime = Date.now();
            }

            const stationaryDuration = Date.now() - this.stationaryStartTime;

            // Switch to low power mode after 1 minute stationary
            if (stationaryDuration > this.STATIONARY_TIME_MS && this.mode !== 'low') {
                console.log('[GPS] Switching to LOW power mode (stationary)');
                this._startWatchWithMode('low');
            }
        } else {
            // Moving - reset stationary timer
            this.stationaryStartTime = null;

            // Determine appropriate mode based on speed
            if (speed > 2.0) {
                // Fast movement (walking briskly / running) - high accuracy
                if (this.mode !== 'high') {
                    console.log('[GPS] Switching to HIGH accuracy mode (fast movement)');
                    this._startWatchWithMode('high');
                }
            } else if (speed > 0.5) {
                // Slow movement (slow walking) - medium accuracy
                if (this.mode !== 'medium') {
                    console.log('[GPS] Switching to MEDIUM accuracy mode (slow movement)');
                    this._startWatchWithMode('medium');
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ESTIMATE DENSITY LEVEL (for notification engine)
    // ═══════════════════════════════════════════════════════════════
    _estimateDensityLevel() {
        // This can be enhanced with actual listing density check
        // For now, use accuracy as proxy (high accuracy in urban areas)
        if (!this.currentAccuracy) return 'normal';

        if (this.currentAccuracy < 20) {
            return 'high'; // Very accurate = urban, high density
        } else if (this.currentAccuracy < 50) {
            return 'normal';
        } else {
            return 'low';
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CALCULATE DISTANCE BETWEEN TWO GPS COORDINATES
    // ═══════════════════════════════════════════════════════════════
    _gpsDistM(lat1, lng1, lat2, lng2) {
        const R = 6371000; // Earth radius in meters
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + 
                  Math.cos(lat1 * Math.PI / 180) * 
                  Math.cos(lat2 * Math.PI / 180) * 
                  Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ═══════════════════════════════════════════════════════════════
    // HANDLE GPS ERROR
    // ═══════════════════════════════════════════════════════════════
    _handleError(error) {
        console.error('[GPS] Error:', error.message);

        switch (error.code) {
            case error.PERMISSION_DENIED:
                console.warn('[GPS] User denied location permission');
                break;
            case error.POSITION_UNAVAILABLE:
                console.warn('[GPS] Location information unavailable');
                break;
            case error.TIMEOUT:
                console.warn('[GPS] Location request timed out');
                // Retry with lower accuracy
                if (this.mode === 'high') {
                    this._startWatchWithMode('medium');
                }
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // GET CURRENT STATE
    // ═══════════════════════════════════════════════════════════════
    getState() {
        return {
            isStationary: this.isStationary,
            speed: this.speed,
            accuracy: this.currentAccuracy,
            mode: this.mode,
            positionHistory: this.positions.length,
            lastPosition: this.lastProcLat && this.lastProcLng ? {
                lat: this.lastProcLat,
                lng: this.lastProcLng
            } : null
        };
    }
}

// ═══════════════════════════════════════════════════════════════════
// USAGE IN map.html (Replace existing GPS code)
// ═══════════════════════════════════════════════════════════════════

/*
// Initialize GPS Manager
const gpsManager = new AdaptiveGPSManager();

// Start tracking
function startWatch() {
    gpsManager.start(
        // Position callback
        (position, movementContext) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            
            loc = { lat, lng };
            SS('lastLoc', loc);
            
            // Update user marker
            if (window.userMarker) {
                window.userMarker.setLatLng([lat, lng]);
            }
            
            // Update map view
            if (!hasLiveCentered) {
                window._map.flyTo([lat, lng], 15, { duration: 0.5 });
                hasLiveCentered = true;
                redraw();
            } else {
                redraw();
            }
            
            // Feed notification engine with movement context
            if (filteredList && filteredList.length > 0) {
                NotificationEngine.evaluate(position, filteredList, movementContext);
            }
        },
        // Movement change callback (optional)
        (state) => {
            console.log('[GPS] Movement state changed:', state);
            // Could show indicator: "Stationary mode - saving battery"
        }
    );
}

// Stop tracking when leaving page
window.addEventListener('beforeunload', () => {
    gpsManager.stop();
});
*/

console.log('[GPS] Adaptive GPS Manager loaded');
