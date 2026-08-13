"""KEPCO 스마트미터 통합."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import CARD_FILES, CARD_VERSION, DOMAIN, FRONTEND_KEY, URL_BASE
from .coordinator import KepcoCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR]


def _lovelace_resources(hass: HomeAssistant):
    """Lovelace 리소스 저장소를 꺼낸다. YAML 모드면 None."""
    data = hass.data.get("lovelace")
    if data is None:
        return None
    # 최신 HA 는 LovelaceData 데이터클래스, 구버전은 dict 였다.
    res = getattr(data, "resources", None)
    if res is None and isinstance(data, dict):
        res = data.get("resources")
    # YAML 모드의 리소스 컬렉션은 생성/수정을 지원하지 않는다.
    return res if res is not None and hasattr(res, "async_create_item") else None


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """카드 JS 를 서빙하고 Lovelace 리소스로 등록한다.

    HACS 는 통합(integration)과 카드(plugin)를 별개 저장소로 취급하지만, 통합이
    직접 리소스를 등록하면 저장소 하나로 끝나고 사용자가 손으로 추가할 필요도 없다.

    `add_extra_js_url` 만 쓰면 안 된다. 그건 스크립트를 붙이기만 할 뿐이라
    대시보드가 카드 정의를 기다리지 않고 먼저 그려서, 새로고침 타이밍에 따라
    `Custom element doesn't exist` 가 뜬다. Lovelace 리소스로 등록하면
    프론트엔드가 리소스 로딩을 끝낸 뒤에 카드를 그린다.
    """
    if hass.data.get(FRONTEND_KEY):
        return  # 계량기를 여러 개 등록해도 한 번만
    hass.data[FRONTEND_KEY] = True

    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, str(Path(__file__).parent / "www"), True)]
    )

    resources = _lovelace_resources(hass)
    if resources is None:
        # YAML 모드 등 리소스 컬렉션을 못 쓰는 환경. 최소한 스크립트는 붙여 준다.
        for name in CARD_FILES:
            add_extra_js_url(hass, f"{URL_BASE}/{name}?v={CARD_VERSION}")
        _LOGGER.debug("Lovelace 리소스를 쓸 수 없어 extra_js_url 로 등록했다")
        return

    if not resources.loaded:
        await resources.async_load()
        resources.loaded = True

    for name in CARD_FILES:
        path = f"{URL_BASE}/{name}"
        # 버전을 붙여야 통합을 올렸을 때 브라우저가 옛 파일을 계속 쓰지 않는다.
        url = f"{path}?v={CARD_VERSION}"
        existing = next(
            (r for r in resources.async_items() if r.get("url", "").split("?")[0] == path),
            None,
        )
        if existing is None:
            await resources.async_create_item({"res_type": "module", "url": url})
            _LOGGER.debug("카드 리소스 등록: %s", url)
        elif existing.get("url") != url:
            await resources.async_update_item(
                existing["id"], {"res_type": "module", "url": url}
            )
            _LOGGER.debug("카드 리소스 갱신: %s", url)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await _async_register_frontend(hass)

    coordinator = KepcoCoordinator(hass, entry)
    await coordinator.async_load_store()
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # 벽시계 기준 고정 시각에 갱신을 예약한다(기동 시각에 좌우되지 않도록).
    entry.async_on_unload(coordinator.async_setup_schedule())
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        coordinator: KepcoCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_shutdown_client()
    return unloaded


async def _async_reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
