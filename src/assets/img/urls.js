// Centralized, bundler-friendly URLs for built-in images.
// Using `new URL(..., import.meta.url)` ensures Vite emits these assets
// into `dist/assets` and rewrites paths in the library output.
export const IMG = {
    toolLog: {
        terrain: new URL('./toolLog/地形.png', import.meta.url).href,
        axes: new URL('./toolLog/坐标轴.png', import.meta.url).href,
        draw: new URL('./toolLog/绘制.png', import.meta.url).href,
        measure: new URL('./toolLog/测量.png', import.meta.url).href,
        animation: new URL('./toolLog/动画.png', import.meta.url).href,
        info: new URL('./toolLog/信息.png', import.meta.url).href,
        terrainEdit: new URL('./toolLog/地形修整.png', import.meta.url).href,
        test: new URL('./toolLog/测试.png', import.meta.url).href,
    },
    measure: {
        point: new URL('./measureImg/坐标点.png', import.meta.url).href,
        distance: new URL('./measureImg/距离测量.png', import.meta.url).href,
        multiDistance: new URL('./measureImg/路程.png', import.meta.url).href,
        area: new URL('./measureImg/面积.png', import.meta.url).href,
        cutFill: new URL('./measureImg/填挖方.png', import.meta.url).href,
        profile: new URL('./measureImg/剖面分析.png', import.meta.url).href,
    },
    point: {
        point: new URL('./pointImg/点.png', import.meta.url).href,
        start: new URL('./pointImg/起点.png', import.meta.url).href,
        end: new URL('./pointImg/终点.png', import.meta.url).href,
    },
};
