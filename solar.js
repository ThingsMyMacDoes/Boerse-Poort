// Sun position (NOAA solar calculator algorithm, accurate to roughly 0.01°) and time-zone helpers.
const Solar = (() => {
    const RAD = Math.PI / 180;
    const DEG = 180 / Math.PI;

    /**
     * Returns the apparent sun position for a moment in time.
     * azimuth: degrees clockwise from north (90 = east, 180 = south)
     * elevation: degrees above the horizon, including atmospheric refraction
     */
    function position(utcMs, lat, lon) {
        const jd = utcMs / 86400000 + 2440587.5;
        const T = (jd - 2451545.0) / 36525;

        const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
        const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
        const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
        const Mr = M * RAD;

        const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
            + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
            + Math.sin(3 * Mr) * 0.000289;
        const omega = (125.04 - 1934.136 * T) * RAD;
        const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;

        const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
        const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;
        const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));

        // Equation of time, in minutes
        const y = Math.tan(eps / 2) ** 2;
        const L0r = L0 * RAD;
        const eqTime = 4 * DEG * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr)
            + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
            - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));

        const utcMin = (((utcMs / 60000) % 1440) + 1440) % 1440;
        const trueSolarMin = utcMin + eqTime + 4 * lon;
        const hourAngle = (trueSolarMin / 4 - 180) * RAD;

        const latR = lat * RAD;
        const cosZen = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle);
        let elevation = 90 - Math.acos(Math.min(1, Math.max(-1, cosZen))) * DEG;

        // Atmospheric refraction (Sæmundsson), lifts the sun slightly near the horizon
        if (elevation > -1) {
            elevation += 1.02 / Math.tan((elevation + 10.3 / (elevation + 5.11)) * RAD) / 60;
        }

        const azimuth = (Math.atan2(
            Math.sin(hourAngle),
            Math.cos(hourAngle) * Math.sin(latR) - Math.tan(decl) * Math.cos(latR)
        ) * DEG + 540) % 360;

        return { azimuth, elevation };
    }

    const formatters = {};

    /** Offset of the time zone from UTC, in minutes, at the given instant (e.g. +120 for CEST). */
    function tzOffsetMin(utcMs, timeZone) {
        const f = formatters[timeZone] || (formatters[timeZone] = new Intl.DateTimeFormat("en-US", {
            timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit"
        }));
        const t = Math.floor(utcMs / 1000) * 1000;
        const p = {};
        for (const { type, value } of f.formatToParts(new Date(t))) p[type] = value;
        const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
        return Math.round((asUtc - t) / 60000);
    }

    function isValidTimeZone(timeZone) {
        try {
            new Intl.DateTimeFormat("en-US", { timeZone });
            return true;
        } catch {
            return false;
        }
    }

    return { position, tzOffsetMin, isValidTimeZone };
})();
