#include <lcms2.h>
#include <stdlib.h>

// A context and a transform belong to one isolated module instance.
void *pp_transform(const void *data, unsigned int size, unsigned int depth) {
    cmsHPROFILE input = cmsOpenProfileFromMem(data, size);
    if (!input) return NULL;
    if (cmsGetColorSpace(input) != cmsSigRgbData) { cmsCloseProfile(input); return NULL; }
    cmsHPROFILE output = cmsCreate_sRGBProfile();
    if (!output) { cmsCloseProfile(input); return NULL; }
    cmsUInt32Number format = depth == 16 ? TYPE_RGBA_16_SE : TYPE_RGBA_8;
    cmsHTRANSFORM transform = cmsCreateTransform(input, format, output, format,
        INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_COPY_ALPHA);
    cmsCloseProfile(input);
    cmsCloseProfile(output);
    return transform;
}
void pp_apply(void *transform, const void *input, void *output, unsigned int count) {
    cmsDoTransform(transform, input, output, count);
}
void pp_close(void *transform) { cmsDeleteTransform(transform); }
unsigned int pp_profile(unsigned int kind, void *output, unsigned int capacity) {
    cmsHPROFILE profile;
    if (kind == 0) { profile = cmsCreate_sRGBProfile(); }
    else if (kind == 1) {
        cmsCIExyY white = {0.3127, 0.3290, 1.0};
        cmsCIExyYTRIPLE primaries = {{0.68,0.32,1.0},{0.265,0.69,1.0},{0.15,0.06,1.0}};
        double params[5] = {2.4, 1.0/1.055, 0.055/1.055, 1.0/12.92, 0.04045};
        cmsToneCurve *curve = cmsBuildParametricToneCurve(NULL, 4, params);
        if (!curve) return 0;
        cmsToneCurve *curves[3] = {curve,curve,curve};
        profile = cmsCreateRGBProfile(&white, &primaries, curves);
        cmsFreeToneCurve(curve);
    }
    else {
        profile = cmsCreate_sRGBProfile();
        if (!profile) return 0;
        cmsSetProfileVersion(profile, 2.1);
        cmsUInt16Number table[24];
        for (int i = 0; i < 24; i++) table[i] = 12000;
        cmsPipeline *pipeline = cmsPipelineAlloc(NULL, 3, 3);
        cmsToneCurve *identity = cmsBuildGamma(NULL, 1.0);
        cmsToneCurve *curves[3] = {identity, identity, identity};
        cmsPipelineInsertStage(pipeline, cmsAT_END, cmsStageAllocToneCurves(NULL, 3, curves));
        cmsPipelineInsertStage(pipeline, cmsAT_END, cmsStageAllocCLut16bit(NULL, 2, 3, 3, table));
        cmsPipelineInsertStage(pipeline, cmsAT_END, cmsStageAllocToneCurves(NULL, 3, curves));
        cmsFreeToneCurve(identity);
        if (!cmsWriteTag(profile, cmsSigAToB0Tag, pipeline)) { cmsPipelineFree(pipeline); cmsCloseProfile(profile); return 0; }
        cmsPipelineFree(pipeline);
    }
    if (!profile) return 0;
    cmsUInt32Number size = capacity;
    int ok = cmsSaveProfileToMem(profile, output, &size);
    cmsCloseProfile(profile);
    return ok ? size : 0;
}
