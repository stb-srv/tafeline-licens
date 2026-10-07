/*
 * Leichtgewichtiger Partikel-Hintergrund (Canvas, keine Abhängigkeiten).
 * - Farbe folgt dem Theme (--primary), reagiert auf Theme-Wechsel
 * - respektiert prefers-reduced-motion (dann nur ein statisches Bild)
 * - pausiert bei verdecktem Tab
 */
(function () {
    'use strict';
    if (window.__tafelineParticles) return;
    window.__tafelineParticles = true;

    var canvas = document.createElement('canvas');
    canvas.className = 'bg-particles';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    var particles = [];
    var w = 0;
    var h = 0;
    var dpr = 1;
    var rgb = '0,191,165';
    var raf = 0;
    var LINK_DIST = 130;

    function readColor() {
        var v = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
        var m = /^#([0-9a-f]{6})$/i.exec(v);
        if (m) {
            var n = parseInt(m[1], 16);
            rgb = (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
        }
    }

    function resize() {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var count = Math.max(24, Math.min(80, Math.round((w * h) / 20000)));
        while (particles.length < count) {
            particles.push({
                x: Math.random() * w,
                y: Math.random() * h,
                vx: (Math.random() - 0.5) * 0.35,
                vy: (Math.random() - 0.5) * 0.35,
                r: 1 + Math.random() * 1.6,
            });
        }
        particles.length = count;
        draw();
    }

    function step() {
        for (var i = 0; i < particles.length; i++) {
            var p = particles[i];
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < -10) p.x = w + 10;
            else if (p.x > w + 10) p.x = -10;
            if (p.y < -10) p.y = h + 10;
            else if (p.y > h + 10) p.y = -10;
        }
    }

    function draw() {
        ctx.clearRect(0, 0, w, h);
        var i, j, a, b, dx, dy, d;
        ctx.lineWidth = 1;
        for (i = 0; i < particles.length; i++) {
            a = particles[i];
            for (j = i + 1; j < particles.length; j++) {
                b = particles[j];
                dx = a.x - b.x;
                dy = a.y - b.y;
                d = dx * dx + dy * dy;
                if (d < LINK_DIST * LINK_DIST) {
                    ctx.strokeStyle = 'rgba(' + rgb + ',' + (0.16 * (1 - Math.sqrt(d) / LINK_DIST)).toFixed(3) + ')';
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                }
            }
        }
        ctx.fillStyle = 'rgba(' + rgb + ',0.5)';
        for (i = 0; i < particles.length; i++) {
            a = particles[i];
            ctx.beginPath();
            ctx.arc(a.x, a.y, a.r, 0, 6.2832);
            ctx.fill();
        }
    }

    function loop() {
        step();
        draw();
        raf = requestAnimationFrame(loop);
    }

    function start() {
        if (raf || motionQuery.matches || document.hidden) return;
        raf = requestAnimationFrame(loop);
    }

    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stop();
        else start();
    });
    var onMotion = function () {
        stop();
        if (motionQuery.matches) draw();
        else start();
    };
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotion);
    var resizeTimer = 0;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 120);
    });
    new MutationObserver(function () {
        readColor();
        if (!raf) draw();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    readColor();
    resize();
    start();
})();
