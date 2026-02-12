<!--
 * @Author: 2409479323@qq.com
 * @Date: 2026-02-12 10:49:07
 * @LastEditors: 2409479323@qq.com 
 * @LastEditTime: 2026-02-12 14:17:21
 * @FilePath: \SpringAndAutumnGIS\README.md
 * @Description: 
 * 
 * Copyright (c) 2026 by bimcc, All Rights Reserved. 
-->
# SpringAndAutumnGIS
SpringAndAutumnGIS

RGB地形服务：https://tiles1.geovisearth.com/base/v1/terrain-rgb/{z}/{x}/{y}?format=png&tmsIds=w&token=a1b140c94dba53eef3541ed85e72e2df16bfa63d8065f0d8a6e16604a035cbe0

卫星瓦片服务：
    
            return {
                baseMapType: 'google',
                mapTileUrl: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&scale=2',
                mapYtype: 'xyz',
                mapSubdomains: '0-3',
                templateToken: null
            };
        
框架基础：three js 

坐标系构建：
    正视地球，地球南北极点与threeY轴重合，地球北就是Y+,西安的所在中心经线作为初始面中心，东经0,北纬0作为正视点，遵循左西右东，上北下南，地球球心与three原点重合

语言：TypeScripts
目标，完成坐标系转换构建【wgs1984,web墨卡托，three坐标，局部坐标系北东天】
构建正确的缩放比例
地形编辑，挖坑，裁剪，替换局部地形，抬升地形，坡面地形，整平地形，高程查询，填挖方计算、点测量，距离测量，路程测量，剖面测量；
地形、地图瓦片lod管理
指定经纬度多边形的自定义纹理贴地表的覆盖层
支持mapboxV8标准的矢量瓦片的渲染



