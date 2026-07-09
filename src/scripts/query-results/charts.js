/// Huge JS libraries should be loaded only if needed.
function loadJS(src, integrity) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        if (integrity) {
            script.crossOrigin = 'anonymous';
            script.integrity = integrity;
        } else {
            console.warn('no integrity for', src)
        }
        script.addEventListener('load', function() { resolve(true); });
        document.head.appendChild(script);
    });
}

let load_dagre_promise;
function loadDagre() {
    if (load_dagre_promise) { return load_dagre_promise; }

    load_dagre_promise = Promise.all([
        loadJS('https://dagrejs.github.io/project/dagre/v0.8.5/dagre.min.js',
                'sha384-2IH3T69EIKYC4c+RXZifZRvaH5SRUdacJW7j6HtE5rQbvLhKKdawxq6vpIzJ7j9M'),
        loadJS('https://dagrejs.github.io/project/graphlib-dot/v0.6.4/graphlib-dot.min.js',
                'sha384-Q7oatU+b+y0oTkSoiRH9wTLH6sROySROCILZso/AbMMm9uKeq++r8ujD4l4f+CWj'),
        loadJS('https://dagrejs.github.io/project/dagre-d3/v0.6.4/dagre-d3.min.js',
                'sha384-9N1ty7Yz7VKL3aJbOk+8ParYNW8G5W+MvxEfFL9G7CRYPmkHI9gJqyAfSI/8190W'),
        loadJS('https://cdn.jsdelivr.net/npm/d3@7.0.0',
                'sha384-S+Kf0r6YzKIhKA8d1k2/xtYv+j0xYUU3E7+5YLrcPVab6hBh/r1J6cq90OXhw80u'),
    ]);

    return load_dagre_promise;
}

async function renderGraph()
{
    clearElement(getCurrentDataTable());
    await loadDagre();

    /// https://github.com/dagrejs/dagre-d3/issues/131
    const dot = explain_graph.replace(/shape\s*=\s*box/g, 'shape=rect');

    let graph = graphlibDot.read(dot);
    let render = new dagreD3.render();

    graph.setGraph({
        nodesep: 20,
        rankdir: 'LR',
    });

    let svg = getCurrentGraph();
    svg.style.display = 'block';

    render(d3.select(svg), graph);

    svg.style.width = graph.graph().width;
    svg.style.height = graph.graph().height;
}

let load_uplot_promise;
function loadUplot() {
    if (load_uplot_promise) { return load_uplot_promise; }
    load_uplot_promise = loadJS('https://cdn.jsdelivr.net/npm/uplot@1.6.21/dist/uPlot.iife.min.js',
        'sha384-TwdJPnTsKP6pnvFZZKda0WJCXpjcHCa7MYHmjrYDu6rsEsb/UnFdoL0phS5ODqTA');
    return load_uplot_promise;
}

function legendAsTooltipPlugin({ className, style = {} } = {}) {
    let legendEl;
    let multiline;

    function init(u, opts) {
        legendEl = u.root.querySelector(".u-legend");
        legendEl.classList.remove("u-inline");
        className && legendEl.classList.add(className);

        uPlot.assign(legendEl.style, {
            textAlign: "right",
            pointerEvents: "none",
            display: "none",
            position: "absolute",
            left: 0,
            top: 0,
            zIndex: 100,
            boxShadow: "2px 2px 10px rgba(0, 0, 0, 0.1)",
            ...style
        });

        const nodes = legendEl.querySelectorAll("th");
        for (let i = 0; i < nodes.length; i++)
            nodes[i]._order = i;

        if (opts.series.length == 2) {
            multiline = false;
            for (let i = 0; i < nodes.length; i++)
                nodes[i].style.display = "none";
        } else {
            multiline = true;
            legendEl.querySelector("th").remove();
            legendEl.querySelector("td").setAttribute('colspan', '2');
            legendEl.querySelector("td").style.textAlign = 'center';
            let footer = legendEl.insertRow().insertCell();
            footer.setAttribute('colspan', '2');
            footer.style.textAlign = 'center';
            footer.classList.add('u-value');
            footer.parentNode.classList.add('u-series','footer');
            footer.textContent = ". . .";
        }

        const overEl = u.over;
        overEl.style.overflow = "visible";

        overEl.appendChild(legendEl);

        overEl.addEventListener("mouseenter", () => {legendEl.style.display = null;});
        overEl.addEventListener("mouseleave", () => {legendEl.style.display = "none";});
    }

    function nodeListToArray(nodeList) {
        return Array.prototype.slice.call(nodeList);
    }

    function update(u) {
        let { left, top } = u.cursor;
        /// This will make the balloon to the right of the cursor when the cursor is on the left side, and vise-versa,
        /// avoiding the borders of the chart.
        left -= legendEl.clientWidth * (left / u.width);
        if (top >= legendEl.clientHeight) {
            top -= legendEl.clientHeight;
        }
        legendEl.style.transform = "translate(" + left + "px, " + top + "px)";

        if (multiline) {
            let nodes = nodeListToArray(legendEl.querySelectorAll("tr"));
            let header = nodes.shift();
            let footer = nodes.pop();
            let showLimit = Math.floor(u.height / 30);
            nodes.forEach(function (node) { node._sort_key = nodes.length > showLimit ? +node.querySelector("td").textContent.replace(/,/g,'') : node._order; });
            nodes.sort((a, b) => b._sort_key - a._sort_key);
            nodes.forEach(function (node) { node.parentNode.appendChild(node); });
            for (let i = 0; i < nodes.length; i++) {
                nodes[i].style.display = i < showLimit ? null : "none";
            }
            footer.parentNode.appendChild(footer);
            footer.style.display = nodes.length > showLimit ? null : "none";
        }
    }

    return {
        hooks: {
            init: init,
            setCursor: update,
        }
    };
}

let uplot;
async function renderChart(json)
{
    await loadUplot();
    clear();

    let chart = getCurrentChart();
    chart.style.display = 'block';

    let paths = json[0].length < chart.clientWidth / 5 ? uPlot.paths.bars() : uPlot.paths.linear();

    const [line_color, fill_color, grid_color, axes_color] = theme == 'light'
        ? ["rgba(255, 0, 200, 100%)", "rgba(255, 128, 200, 50%)", "#CCC", "#444"]
        : ["rgba(255, 255, 0, 100%)", "rgba(255, 255, 100, 50%)", "#444", "#CCC"];

    const opts = {
        width: chart.clientWidth,
        height: chart.clientHeight,
        scales: { x: { time: json[0][0] > 1000000000 && json[0][0] < 2000000000 } },
        axes: [ { stroke: axes_color,
                    grid: { width: 1 / devicePixelRatio, stroke: grid_color },
                    ticks: { width: 1 / devicePixelRatio, stroke: grid_color } },
                { stroke: axes_color,
                    grid: { width: 1 / devicePixelRatio, stroke: grid_color },
                    ticks: { width: 1 / devicePixelRatio, stroke: grid_color } } ],
        series: [ { label: "x" },
                    { label: "y", stroke: line_color, fill: fill_color, paths, points: { show: false } } ],
        padding: [ null, null, null, (Math.ceil(Math.log10(Math.max(...json[1]))) + Math.floor(Math.log10(Math.max(...json[1])) / 3)) * 6 ],
        plugins: [ legendAsTooltipPlugin() ],
    };

    uplot = new uPlot(opts, json, chart);
}

function resizeChart() {
    if (uplot && getCurrentChart()) {
        let chart = getCurrentChart();
        uplot.setSize({ width: chart.clientWidth, height: chart.clientHeight });
    }
}

function redrawChart() {
    if (uplot && getCurrentChart() && getCurrentChart().style.display == 'block') {
        renderChart(uplot.data);
    }
}
