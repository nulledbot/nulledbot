import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { UAParser } from "ua-parser-js";

const rateLimitStore = new Map();
const RATE_LIMIT = 5;
const WINDOW_SIZE = 60 * 1000;

function rateLimit(ip) {
    const now = Date.now();
    const entry = rateLimitStore.get(ip) || { count: 0, timestamp: now };

    if (now - entry.timestamp < WINDOW_SIZE) {
        if (entry.count >= RATE_LIMIT) return false;
        entry.count++;
    } else {
        entry.count = 1;
        entry.timestamp = now;
    }

    rateLimitStore.set(ip, entry);
    return true;
}

function handleBlock(reason, statusCode) {
    const code = Number(statusCode);
    if ([403, 404].includes(code)) {
        return NextResponse.json({ error: reason }, { status: code });
    }
    return NextResponse.redirect("https://example.com");
}

export async function GET(req, context) {
    const params = await context.params;
    const key = params.key;

    const ua = req.headers.get("user-agent") || "";
    const parser = new UAParser(ua);
    const deviceType = parser.getDevice().type || "Desktop";

    const suspiciousUserAgents = [
        "bot", "spider", "crawl", "curl", "wget", "python", "java",
        "httpclient", "libwww", "scrapy", "go-http-client",
        "phantomjs", "headless", "selenium", "node-fetch"
    ];

    const uaLower = ua.toLowerCase();
    const matchedBotSignature = suspiciousUserAgents.find(keyword =>
        uaLower.includes(keyword)
    );

    let ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "8.8.8.8";
    if (ip === "::1" || ip === "127.0.0.1") ip = "8.8.8.8";

    if (!rateLimit(ip)) {
        return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const client = await clientPromise;
    const db = client.db();

    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) return NextResponse.json({ error: "Missing API key" }, { status: 401 });

    const userProfile = await db.collection("user_profiles").findOne({ apiKey });
    if (!userProfile) return NextResponse.json({ error: "Invalid API key" }, { status: 403 });

    if (!key) return NextResponse.json({ error: "Missing key" }, { status: 400 });

    const shortlink = await db.collection("shortlinks").findOne({ key });
    if (!shortlink) return NextResponse.json({ error: "Shortlink not found" }, { status: 404 });

    let ipData = {};
    try {
        const url = `https://ipdetective.p.rapidapi.com/ip/${ip}?info=true`;
        const options = {
            method: 'GET',
            headers: {
                'x-rapidapi-key': process.env.X_API_KEY,
                'x-rapidapi-host': 'ipdetective.p.rapidapi.com'
            }
        };
        const response = await fetch(url, options);
        ipData = await response.json();
    } catch (error) {
        console.error("IPDetective API error:", error);
        return NextResponse.json({ error: "Unable to verify IP location" }, { status: 500 });
    }

    let ipwhoData = {};
    try {
        const ipRes = await fetch(`https://ipwho.is/${ip}`);
        const result = await ipRes.json();
        if (result.success) {
            ipwhoData = result;
        }
    } catch (err) {
        console.error("ipwho.is fetch failed:", err);
    }

    const botProviders = [
        "cdnext", "amazon", "google", "apple", "microsoft",
        "digitalocean", "cloudflare", "datacamp", "ovh",
        "linode", "vultr", "akamai", "fastly"
    ];
    const isp = (ipData?.asn_description || "").toLowerCase();
    const isCloudASN = botProviders.some(provider => isp.includes(provider));
    const isBotFlagged = ipData?.bot === true;

    let isBlocked = false;
    let blockReason = null;

    if (!shortlink.allowedIsp || !isp.includes(shortlink.allowedIsp.toLowerCase())) {
        if (isCloudASN || isBotFlagged) {
            isBlocked = true;
            blockReason = "BOT is not allowed";
        }
    }

    if (!isBlocked && shortlink.allowedCountry) {
        const userCountry = ipData?.country_code || null;
        if (!userCountry || userCountry.toUpperCase() !== shortlink.allowedCountry.toUpperCase()) {
            isBlocked = true;
            blockReason = "Your country is banned from accessing this resource.";
        }
    }

    if (!isBlocked && shortlink.allowedDevice && shortlink.allowedDevice !== "Allow All") {
        if (
            (shortlink.allowedDevice === "Mobile" && deviceType !== "Mobile") ||
            (shortlink.allowedDevice === "Desktop" && deviceType !== "Desktop")
        ) {
            isBlocked = true;
            blockReason = "Device not allowed";
        }
    }

    const ipType = (ipData?.type || "").toLowerCase();
    if (!isBlocked && (
        (shortlink.connectionType === "Block Proxy" && ipType === "proxy") ||
        (shortlink.connectionType === "Block VPN" && ipType === "vpn") ||
        (ipType === "datacenter") ||
        (shortlink.connectionType === "Block All" && ["vpn", "proxy", "datacenter"].includes(ipType))
    )) {
        const messageMap = {
            "proxy": "PROXY is not allowed",
            "vpn": "VPN is not allowed",
            "datacenter": "DATACENTER is not allowed",
        };
        blockReason = shortlink.connectionType === "Block All"
            ? "VPN or Proxy is not allowed"
            : messageMap[ipType] || "Access denied";
        isBlocked = true;
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentLog = await db.collection("visitors").findOne({
        shortlinkKey: shortlink.key,
        ip,
        visitedAt: { $gt: oneHourAgo }
    });

    if (!blockReason && matchedBotSignature) {
        isBlocked = true;
        blockReason = `BOT User Agent`;
    }

    if (!blockReason) {
        blockReason = "Real Human";
    }

    if (!recentLog) {
        try {
            let finalType = ipType;
            if ((!finalType || finalType === "unknown") && matchedBotSignature) {
                finalType = matchedBotSignature;
            }

            const insertResult = await db.collection("visitors").insertOne({
                shortlinkKey: shortlink.key,
                shortlinkId: shortlink._id,
                visitedAt: new Date(),
                ip,
                userAgent: ua,
                device: deviceType,
                location: {
                    country: ipwhoData.country,
                    country_code: ipwhoData.country_code,
                    region: ipwhoData.region,
                    city: ipwhoData.city,
                    latitude: ipwhoData.latitude,
                    longitude: ipwhoData.longitude,
                    isp: ipwhoData.connection?.isp || null,
                    flag_img: ipwhoData.flag?.img || null,
                },
                timezone: ipwhoData.timezone?.id || null,
                type: finalType,
                isBot: ipData?.bot,
                isBlocked,
                blockReason,
            });
        } catch (err) {
            console.error("Failed to log visit:", err);
        }
    }

    if (isBlocked) {
        return handleBlock(blockReason, shortlink.statusCode);
    }

    return NextResponse.redirect(shortlink.url);
}
