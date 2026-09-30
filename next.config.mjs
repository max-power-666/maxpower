/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // qz-tray (lib/printAgent.ts) opcjonalnie próbuje require('lna') — pakietu do wykrywania Local Network
    // Access w nowszych Chrome, którego nie instalujemy (qz-tray sam łapie brak tej biblioteki w try/catch
    // i działa dalej bez niej). Bez tego aliasu webpack tylko ostrzega przy każdym buildzie o brakującym module.
    config.resolve.alias = { ...config.resolve.alias, lna: false };
    return config;
  },
};
export default nextConfig;
